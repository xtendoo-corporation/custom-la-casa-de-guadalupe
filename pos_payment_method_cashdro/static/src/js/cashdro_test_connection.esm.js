/** @odoo-module */
/**
 * Client action that tests the CashDro connection directly from the browser.
 *
 * Why from the browser and not from the Odoo server?
 * --------------------------------------------------
 * The CashDro device lives on the store's local network (e.g. 192.168.1.137).
 * The Odoo server may run in Docker, in the cloud, or on a different network
 * segment – it simply cannot reach a private LAN IP.  The *browser* of the
 * person configuring the payment method, however, IS on that same local
 * network, so the fetch() request can reach the CashDro just fine.
 */
import { registry } from "@web/core/registry";
import { Component, xml } from "@odoo/owl";

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

        const url =
            `${host}/Cashdro3WS/index.php` +
            `?name=${encodeURIComponent(user || "")}` +
            `&password=${encodeURIComponent(password || "")}` +
            `&operation=askOperation&operationId=0`;

        this.env.services.notification.add(
            "Testing connection to CashDro from your browser…",
            { title: "CashDro", type: "info" }
        );

        const MAX_RETRIES = 3;
        const INITIAL_DELAY = 2000; // ms

        let lastError;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(
                    `[CashDro Test] Attempt ${attempt}/${MAX_RETRIES}: ${url}`
                );
                const response = await fetch(url, {
                    method: "GET",
                    // Allow HTTPS page to fetch HTTP on private network
                    targetAddressSpace: "local",
                });
                const text = await response.text();
                console.log("[CashDro Test] Response:", response.status, text);

                if (response.ok) {
                    this.env.services.notification.add(
                        `Connection successful! Response: ${text.substring(0, 100)}`,
                        { title: "CashDro – Success", type: "success", sticky: false }
                    );
                } else {
                    this.env.services.notification.add(
                        `Connection returned HTTP ${response.status}`,
                        { title: "CashDro – Warning", type: "warning", sticky: false }
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
                `Make sure your browser can reach ${host} on the local network. ` +
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

