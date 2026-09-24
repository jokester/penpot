// Creating a Penpot profile, which only the backend container can do.
//
// There is no RPC command for it: self-registration is off on a private
// instance, and a worker has no mailbox to confirm from. `manage.py` reaches
// the backend's PREPL and makes the profile directly, so provisioning shells
// into the admin container for this one step and talks RPC for the rest.
//
// The password goes on stdin rather than behind `-p`. `manage.py` prompts for
// it when the flag is absent, and with no terminal `getpass` reads a line from
// stdin instead -- which keeps the password out of two process lists, the
// host's and the container's. Passing it as a flag is how a worker password
// leaked the first time.

import { fail } from "../core/errors.ts";
import type { ExecBackend } from "../exec/backend.ts";

const TIMEOUT_MS = 60_000;

/** What provisioning needs done inside the container. */
export interface WorkerAdmin {
    /** Creates the profile, or reports that it was already there. */
    createProfile(name: string, email: string, password: string): Promise<"created" | "exists">;
    /** Sets an existing profile's password. */
    setPassword(email: string, password: string): Promise<void>;
}

export function workerAdmin(backend: ExecBackend, timeoutMs = TIMEOUT_MS): WorkerAdmin {
    /** Runs one `manage.py` action in the admin container. */
    async function manage(argv: readonly string[], password: string): Promise<{ code: number; output: string }> {
        const result = await backend.run(["python3", "manage.py", ...argv], AbortSignal.timeout(timeoutMs), {
            container: "admin",
            // Answers the prompt, and the trailing newline is what ends it.
            stdin: `${password}\n`,
        });
        return { code: result.code, output: `${result.stdout}${result.stderr}`.trim() };
    }

    return {
        async createProfile(name, email, password) {
            const { code, output } = await manage(
                ["create-profile", "-n", name, "-e", email, "--skip-tutorial", "--skip-walkthrough"],
                password
            );
            if (code === 0) return "created";
            if (/already exists/i.test(output)) return "exists";

            fail("probe-failed", `create-profile failed: ${output.slice(0, 300)}`, { email });
        },

        async setPassword(email, password) {
            const { code, output } = await manage(["update-profile", "-e", email], password);
            if (code !== 0) {
                fail("probe-failed", `update-profile failed: ${output.slice(0, 300)}`, { email });
            }
        },
    };
}
