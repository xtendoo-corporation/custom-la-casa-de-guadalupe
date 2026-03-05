/** @odoo-module */
/**
 * Client action that tests the CashDro connection through the Odoo backend
 * proxy (``/cashdro/proxy``).
 *
 * The proxy avoids HTTPS → HTTP mixed-content issues because the browser
 * only talks to Odoo (same origin, HTTPS) and it is the Python backend
 * that reaches the CashDro device over plain HTTP on the LAN.
 */
import { registry } from "@web/core/registry";
import { Component, xml } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";

class CashdroTestConnection extends Component {
    static template = xml`<div/>`;
    static props = ["*"];

    setup() {
        const params = this.props.action.params || {};
        this._runTest(params);
    }

    async _runTest(params) {
        const { host, user, password } = params;
        if (!host) {
            this.env.services.notification.add("CashDro Host is not defined.", {
                title: "Error",
                type: "danger",
            });
            this._goBack();
            return;
        }

        const cashdro_url =
            `${host}/Cashdro3WS/index.php` +
            `?name=${encodeURIComponent(user || "")}` +
            `&password=${encodeURIComponent(password || "")}` +
            `&operation=askOperation&operationId=0`;

        this.env.services.notification.add(
            "Testing connection to CashDro via server proxy…",
            { title: "CashDro", type: "info" }
        );

        const MAX_RETRIES = 3;
        const INITIAL_DELAY = 2000; // ms

        let lastError;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(
                    `[CashDro Test] Attempt ${attempt}/${MAX_RETRIES} (via proxy): ${cashdro_url}`
                );
                const result = await rpc("/cashdro/proxy", { cashdro_url });
                console.log("[CashDro Test] Proxy response:", result);

                if (result.ok) {
                    this.env.services.notification.add(
                        `Connection successful! Response: ${JSON.stringify(result.data).substring(0, 100)}`,
                        { title: "CashDro – Success", type: "success", sticky: false }
                    );
                } else {
                    this.env.services.notification.add(
                        `CashDro error: ${result.error}`,
                        { title: "CashDro – Warning", type: "warning", sticky: true }
                    );
                }
                this._goBack();
                return;
            } catch (error) {
                lastError = error;
                console.warn(
                    `[CashDro Test] Attempt ${attempt} failed:`,
                    error.message || error
                );
                if (attempt < MAX_RETRIES) {
                    const delay = INITIAL_DELAY * Math.pow(2, attempt - 1);
                    console.log(`[CashDro Test] Waiting ${delay}ms before retry…`);
                    await new Promise((r) => setTimeout(r, delay));
                }
            }
        }

        // All retries exhausted
        console.error("[CashDro Test] All attempts failed:", lastError);
        this.env.services.notification.add(
            `Could not connect to CashDro after ${MAX_RETRIES} retries. ` +
                `Make sure the Odoo server can reach ${host}. ` +
                `Error: ${lastError?.message || lastError}`,
            { title: "CashDro – Connection Error", type: "danger", sticky: true }
        );
        this._goBack();
    }

    _goBack() {
        // Navigate back to the previous view
        this.env.services.action.doAction({ type: "ir.actions.act_window_close" });
    }
}

registry.category("actions").add("cashdro_test_connection", CashdroTestConnection);

