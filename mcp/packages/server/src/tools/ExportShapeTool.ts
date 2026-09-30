import { z } from "zod";
import { Tool } from "../Tool";
import { ImageContent, PNGResponse, TextContent, TextResponse, ToolResponse } from "../ToolResponse";
import "reflect-metadata";
import { PenpotMcpServer } from "../PenpotMcpServer";
import { ExecuteCodePluginTask } from "../tasks/ExecuteCodePluginTask";
import { createLogger } from "../logger";
import { FileUtils } from "../utils/FileUtils";
import { Semaphore } from "../utils/Semaphore";
import sharp from "sharp";

/**
 * Arguments class for ExportShapeTool
 */
export class ExportShapeArgs {
    static schema = {
        shapeId: z
            .string()
            .min(1, "shapeId cannot be empty")
            .describe(
                "Identifier of the shape to export. " +
                    "Special identifiers you can use: 'selection' (first shape currently selected by the user), 'page' (entire current page)"
            ),
        format: z.enum(["svg", "png"]).default("png").describe("The output format, either 'png' (default) or 'svg'."),
        mode: z
            .enum(["shape", "fill"])
            .default("shape")
            .describe(
                "The export mode: either 'shape' (full shape as it appears in the design, including descendants; the default) or " +
                    "'fill' (export the raw image that is used as a fill for the shape; PNG format only)"
            ),
        filePath: z
            .string()
            .optional()
            .describe(
                "Optional file path to save the exported image to. If not provided, " +
                    "the image data is returned directly for you to see."
            ),
    };

    shapeId!: string;

    format: "svg" | "png" = "png";

    mode: "shape" | "fill" = "shape";

    filePath?: string;
}

/**
 * Tool for executing JavaScript code in the Penpot plugin context
 */
export class ExportShapeTool extends Tool<ExportShapeArgs> {
    /**
     * Maximum number of image-export operations that may run concurrently in multi-user mode.
     * Configurable via the PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS environment variable;
     * defaults to 0, meaning no limit.
     *
     * When set to a positive value (and combined with the plugin-side per-response cap
     * MAX_TASK_RESPONSE_SIZE_REMOTE_MCP, ~15 MB JSON), this caps the in-flight memory
     * footprint of image exports at roughly N x cap on the centrally hosted MCP server.
     */
    private static readonly MAX_PARALLEL_EXPORTS = parseInt(
        process.env.PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS ?? "0",
        10
    );

    /**
     * Gates concurrent export operations across all tool instances (one per session in
     * multi-user mode). Static because instances are per-session, but the bound has to
     * apply across the whole process. Permits beyond the maximum queue in FIFO order.
     * Undefined when MAX_PARALLEL_EXPORTS is non-positive, indicating no limit.
     */
    private static readonly parallelismSemaphore: Semaphore | undefined =
        ExportShapeTool.MAX_PARALLEL_EXPORTS > 0
            ? new Semaphore("ExportShapeTool", ExportShapeTool.MAX_PARALLEL_EXPORTS)
            : undefined;

    static {
        createLogger("ExportShapeTool").info(
            "Max parallel exports (multi-user mode): %d (0 = unbounded)",
            ExportShapeTool.MAX_PARALLEL_EXPORTS
        );
    }

    private readonly exportLogger = createLogger("ExportShapeTool");

    /**
     * Creates a new ExecuteCode tool instance.
     *
     * @param mcpServer - The MCP server instance
     */
    constructor(mcpServer: PenpotMcpServer) {
        let schema: any = ExportShapeArgs.schema;
        if (!mcpServer.isFileSystemAccessEnabled()) {
            // remove filePath key from schema
            schema = { ...schema };
            delete schema.filePath;
        }
        super(mcpServer, schema);
    }

    public getToolName(): string {
        return "export_shape";
    }

    public getToolDescription(): string {
        let description =
            "Exports a shape (or a shape's image fill) from the Penpot design to a PNG or SVG image, " +
            "such that you can get an impression of what it looks like.";
        if (this.mcpServer.isFileSystemAccessEnabled()) {
            description += "\nAlternatively, you can save it to a file.";
        }
        return description;
    }

    protected async executeCore(args: ExportShapeArgs): Promise<ToolResponse> {
        // bound concurrent exports in multi-user mode to keep peak server memory under control;
        // in single-user mode (or when no limit is configured) the gate is irrelevant
        // and the export runs directly
        if (this.mcpServer.isMultiUserMode() && ExportShapeTool.parallelismSemaphore) {
            return ExportShapeTool.parallelismSemaphore.withPermit(() => this.exportImage(args));
        } else {
            return this.exportImage(args);
        }
    }

    /**
     * Performs the actual image export: requests the image via the plugin and either
     * returns it as a tool response or saves it to the requested file path. The bulk
     * of the memory pressure (parsed plugin response, decoded image buffer, optional
     * re-encoding via sharp) lives here, which is why executeCore gates the call.
     *
     * @param args - the validated tool arguments
     */
    private async exportImage(args: ExportShapeArgs): Promise<ToolResponse> {
        // check arguments
        if (args.filePath) {
            FileUtils.checkPathIsAbsolute(args.filePath);
        }

        // create code for exporting the shape
        let shapeCode: string;
        if (args.shapeId === "selection") {
            shapeCode = `penpot.selection[0]`;
        } else if (args.shapeId === "page") {
            shapeCode = `penpot.root`;
        } else {
            shapeCode = `penpotUtils.findShapeById("${args.shapeId}")`;
        }
        const asSvg = args.format === "svg";
        let imageData: Uint8Array | object;
        try {
            imageData = await this.requestShapeBytes(shapeCode, args.mode, asSvg);
        } catch (err) {
            // The one path that renders through the WASM rasteriser -- a
            // "shape" PNG -- can fail there for reasons that are the render
            // pipeline's, not the shape's (observed: `_render_shape_pixels`
            // throwing under software GL; root cause unresolved as of the
            // 2026-09-25 journal). SVG export does not touch that rasteriser
            // at all, so re-requesting the shape as SVG and rasterising it
            // here sidesteps the broken path entirely. Fidelity is not
            // identical to the native renderer, but a slightly different PNG
            // beats a hard failure on every export.
            if (args.mode !== "shape" || asSvg) throw err;
            this.exportLogger.warn(
                "PNG export of shape %s failed in the plugin (%s); falling back to SVG rasterised with sharp",
                args.shapeId,
                err instanceof Error ? err.message : String(err)
            );
            try {
                const svgData = await this.requestShapeBytes(shapeCode, args.mode, true);
                const svgBytes = ImageContent.byteData(svgData);
                imageData = await sharp(Buffer.from(svgBytes)).png().toBuffer();
            } catch (fallbackErr) {
                throw new Error(
                    `PNG export failed (${err instanceof Error ? err.message : String(err)}), ` +
                        `and the SVG fallback failed too`,
                    { cause: fallbackErr }
                );
            }
        }

        // handle output and return response
        if (!args.filePath) {
            // return image data directly (for the LLM to "see" it)
            if (args.format === "png") {
                return new PNGResponse(await this.toPngImageBytes(imageData));
            } else {
                return TextResponse.fromData(imageData);
            }
        } else {
            // save to file requested: make sure file system access is enabled
            if (!this.mcpServer.isFileSystemAccessEnabled()) {
                throw new Error("File system access is not enabled on the MCP server!");
            }
            // save to file
            if (args.format === "png") {
                FileUtils.writeBinaryFile(args.filePath, await this.toPngImageBytes(imageData));
            } else {
                FileUtils.writeTextFile(args.filePath, TextContent.textData(imageData));
            }
            return new TextResponse(`The shape has been exported to ${args.filePath}`);
        }
    }

    /**
     * Asks the plugin to export a shape and returns its raw (possibly enveloped) bytes.
     *
     * @param shapeCode - expression resolving to the `Shape` to export, in plugin scope
     * @param mode - "shape" for the shape itself, "fill" for its image fill
     * @param asSvg - whether to request SVG (true) or PNG (false); "fill" is PNG only
     */
    private async requestShapeBytes(
        shapeCode: string,
        mode: "shape" | "fill",
        asSvg: boolean
    ): Promise<Uint8Array | object> {
        const code = `return penpotUtils.exportImage(${shapeCode}, "${mode}", ${asSvg});`;
        const task = new ExecuteCodePluginTask({ code: code });
        const result = await this.mcpServer.pluginBridge.executePluginTask(task);
        return result.data!.result;
    }

    /**
     * Converts image data to PNG format if necessary.
     *
     * @param data - The original image data as Uint8Array or as object (from JSON conversion of Uint8Array)
     * @return The image data as PNG bytes
     */
    private async toPngImageBytes(data: Uint8Array | object): Promise<Uint8Array> {
        const originalBytes = ImageContent.byteData(data);

        // use sharp to detect format and convert to PNG if necessary
        const image = sharp(originalBytes);
        const metadata = await image.metadata();

        // if already PNG, return as-is to avoid unnecessary re-encoding
        if (metadata.format === "png") {
            return originalBytes;
        }

        // convert to PNG
        const pngBuffer = await image.png().toBuffer();
        return new Uint8Array(pngBuffer);
    }
}
