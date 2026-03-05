/** @odoo-module */
/* Copyright 2021 Tecnativa - David Vidal
   License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).*/
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { _t } from "@web/core/l10n/translation";
import { rpc } from "@web/core/network/rpc";

// ── Cashdro S connection tuning ──────────────────────────────────────────
// The Cashdro Model S has a very limited embedded HTTP server (single thread).
// When it's busy counting coins it cannot accept new TCP connections, causing
// transient ConnectTimeoutError. These constants control the retry behaviour.
const CASHDRO_REQUEST_MAX_RETRIES = 3; // retries per individual HTTP request
const CASHDRO_REQUEST_INITIAL_DELAY = 2000; // ms before first retry (doubles each time)
const CASHDRO_POLL_INITIAL_INTERVAL = 1000; // ms – first poll wait
const CASHDRO_POLL_MAX_INTERVAL = 5000; // ms – cap for progressive poll wait
const CASHDRO_POLL_INTERVAL_INCREMENT = 500; // ms added each successful poll cycle
const CASHDRO_POLL_MAX_ERRORS = 5; // consecutive HTTP errors before aborting poll
const CASHDRO_POLL_GLOBAL_TIMEOUT = 5 * 60 * 1000; // 5 min global timeout for polling

export class PaymentCashdro extends PaymentInterface {
    /**
     * @override
     */
    setup() {
        super.setup(...arguments);
        this.supports_reversals = true;
    }

    /**
     * @override
     */
    sendPaymentReversal(uuid) {
        super.sendPaymentReversal(...arguments);
        const order = this.pos.getOrder();
        const line = order.getSelectedPaymentline();
        line.setPaymentStatus("reversing");
        return this.cashdro_send_payment_request(order);
    }

    /**
     * @override
     */
    sendPaymentCancel() {
        super.sendPaymentCancel(...arguments);
        const operation = this.pos.getOrder().cashdro_operation;
        if (!operation) {
            return Promise.resolve();
        }
        return this.cashdro_finish_operation(operation);
    }

    /**
     * @override
     */
    sendPaymentRequest() {
        super.sendPaymentRequest(...arguments);
        const order = this.pos.getOrder();
        const line = order.getSelectedPaymentline();
        line.setPaymentStatus("waiting");
        return this.cashdro_send_payment_request(order);
    }

    // --------------------------------------------------------------------------
    // Private
    // --------------------------------------------------------------------------

    async cashdro_send_payment_request(order) {
        const payment_line = order.getSelectedPaymentline();
        console.log("[Cashdro] Starting payment request for order:", order.uuid);
        try {
            // Cashdro treats decimals as positions in an integer we also have
            // to deal with floating point computing to avoid decimals at the
            // end or the drawer will reject our request.
            const amount = Math.round(order.remainingDue * 100);
            const payment_url = this._cashdro_payment_url({ amount: amount });
            console.log("[Cashdro] Calculated amount (cents):", amount);
            console.log("[Cashdro] Payment URL:", payment_url);

            console.log("[Cashdro] Sending startOperation request...");
            const res = await this._cashdro_request(payment_url);
            console.log("[Cashdro] startOperation response:", res);

            const operation_id = res.data || "";
            if (!operation_id) {
                // If it's not a successful operation string, it might be a JSON error response
                let error_msg = "No operation ID received from Cashdro";
                try {
                    const error_data = JSON.parse(res.data);
                    if (error_data.code && error_data.code < 0) {
                        error_msg = `CashDro Error [${error_data.code}]: ${error_data.message || 'Unknown error'}`;
                        if (error_data.code === -3) {
                             error_msg = "CashDro is currently busy counting coins or bills. Please wait a moment and try again.";
                        }
                    }
                } catch(e) { /* ignore parse error */ }
                throw new Error(error_msg);
            }
            console.log("[Cashdro] Received Operation ID:", operation_id);
            this.pos.getOrder().cashdro_operation = operation_id;

            // Acknowledge the operation
            const ack_url = this._cashdro_ack_url(operation_id);
            console.log("[Cashdro] Sending acknowledgeOperationId request...", ack_url);
            const res_ack = await this._cashdro_request(ack_url);
            console.log("[Cashdro] acknowledgeOperationId response:", res_ack);

            // Validate the operation (polling with tolerance)
            const ask_url = this._cashdro_ask_url(operation_id);
            console.log("[Cashdro] Starting polling for operation status...", ask_url);
            const operation_data = await this._cashdro_request_payment(ask_url);
            console.log("[Cashdro] Final operation data received:", operation_data);

            const data = JSON.parse(operation_data.data);
            payment_line.cashdro_operation_data = data;
            const tendered = data.operation.totalin / 100;
            console.log("[Cashdro] Total tendered (from data.operation.totalin):", tendered);

            console.log("[Cashdro] Setting payment line amount and finishing...");
            payment_line.setAmount(tendered);
        } catch (error) {
            console.error("[Cashdro] Error during payment request:", error);
            payment_line.setPaymentStatus("retry");
            this.env.services.dialog.add(AlertDialog, {
                title: _t("Error"),
                body: _t(
                    "An error occurred while connecting to the cashdro: %s",
                    error.message || error
                ),
            });
            return false;
        }
        return true;
    }

    async cashdro_finish_operation(operation) {
        console.log("[Cashdro] Finishing operation:", operation);
        const order = this.pos.getOrder();
        if (operation) {
            const finish_url = this._cashdro_finish_url(operation);
            console.log("[Cashdro] Sending finishOperation request...", finish_url);
            try {
                const res = await this._cashdro_request(finish_url);
                console.log("[Cashdro] finishOperation response:", res);
                order.cashdro_operation = false;
            } catch (error) {
                console.error("[Cashdro] Error finishing operation:", error);
            }
        }
    }

    // ── URL builders ─────────────────────────────────────────────────────

    _cashdro_url() {
        const order = this.pos.getOrder();
        if (!order) {
            console.warn("[Cashdro] No active order found to build URL");
            return false;
        }
        const selected_line = order.getSelectedPaymentline();
        if (!selected_line) {
            console.warn("[Cashdro] No selected payment line found to build URL");
            return false;
        }
        const method = selected_line.payment_method_id;
        const host = method && method.cashdro_host;
        if (!host) {
            console.error(
                "[Cashdro] Cashdro host is missing in payment method configuration"
            );
            return false;
        }
        let url = `${host}/Cashdro3WS/index.php`;
        url += `?name=${method.cashdro_user}`;
        url += `&password=${method.cashdro_password}`;
        return url;
    }

    _cashdro_payment_url(parameters) {
        const user = this.pos.cashier.id || this.pos.user.id;
        const operationType = parameters.amount > 0 ? 4 : 3;
        parameters = { ...parameters, amount: Math.abs(parameters.amount) };
        const base_url = this._cashdro_url();
        if (!base_url) return "";
        let url = `${base_url}&operation=startOperation&type=${operationType}`;
        url += `&posid=pos-${this.pos.session.name}`;
        url += `&posuser=${user}`;
        // Enforce idempotency: pass order uuid as aliasid so Cashdro does not start 2 operations
        const order_id = this.pos.getOrder() ? this.pos.getOrder().uuid : Date.now();
        url += `&aliasid=${order_id}`;
        url += `&parameters=${encodeURIComponent(JSON.stringify(parameters))}`;
        return url;
    }

    _cashdro_ack_url(operation_id) {
        const base_url = this._cashdro_url();
        if (!base_url) return "";
        return `${base_url}&operation=acknowledgeOperationId&operationId=${operation_id}`;
    }

    _cashdro_ask_url(operation_id) {
        const base_url = this._cashdro_url();
        if (!base_url) return "";
        return `${base_url}&operation=askOperation&operationId=${operation_id}`;
    }

    _cashdro_finish_url(operation_id) {
        const base_url = this._cashdro_url();
        if (!base_url) return "";
        return `${base_url}&operation=finishOperation&type=2&operationId=${operation_id}`;
    }

    // ── HTTP layer with retries & exponential backoff ────────────────────

    /**
     * Send a request to the CashDro device **through the Odoo backend proxy**
     * (``/cashdro/proxy``).
     *
     * Why a proxy?
     * ------------
     * Odoo is served over HTTPS.  The CashDro only speaks plain HTTP (or
     * HTTPS with a self-signed cert) on the LAN.  Browsers block these
     * requests as "mixed content" → ERR_CERT_AUTHORITY_INVALID.
     *
     * By routing through /cashdro/proxy the browser only talks HTTPS to
     * Odoo, and the Python backend talks HTTP to the CashDro on the LAN
     * with verify=False (as recommended by the CashDro manual §3.1.1).
     *
     * @param {string} url – full URL to the CashDro device
     * @returns {Promise<Object>} parsed JSON response from CashDro
     */
    async _cashdro_fetch(url) {
        const result = await rpc("/cashdro/proxy", { cashdro_url: url });
        if (!result.ok) {
            throw new Error(result.error || "Unknown CashDro proxy error");
        }
        return result.data;
    }

    /**
     * Send a request to the Cashdro with automatic retries and exponential
     * backoff.  The Cashdro S often refuses TCP connections while it is busy;
     * retrying after a short wait usually succeeds.
     *
     * @param {string} url
     * @returns {Promise<Object>} parsed JSON response
     */
    async _cashdro_request(url) {
        let lastError;
        for (let attempt = 1; attempt <= CASHDRO_REQUEST_MAX_RETRIES; attempt++) {
            try {
                console.log(
                    `[Cashdro] Request attempt ${attempt}/${CASHDRO_REQUEST_MAX_RETRIES}: ${url}`
                );
                const data = await this._cashdro_fetch(url);
                console.log("[Cashdro] Response data:", data);
                return data;
            } catch (error) {
                lastError = error;
                console.warn(
                    `[Cashdro] Attempt ${attempt} failed:`,
                    error.message || error
                );
                if (attempt < CASHDRO_REQUEST_MAX_RETRIES) {
                    const delay =
                        CASHDRO_REQUEST_INITIAL_DELAY * Math.pow(2, attempt - 1);
                    console.log(`[Cashdro] Waiting ${delay}ms before retry…`);
                    await new Promise((r) => setTimeout(r, delay));
                }
            }
        }
        console.error(
            `[Cashdro] All ${CASHDRO_REQUEST_MAX_RETRIES} attempts failed.`
        );
        throw lastError;
    }

    /**
     * Poll the Cashdro for the operation result.  Tolerates transient network
     * errors (up to CASHDRO_POLL_MAX_ERRORS consecutive) and uses a
     * progressive interval that grows from CASHDRO_POLL_INITIAL_INTERVAL up to
     * CASHDRO_POLL_MAX_INTERVAL.  A global timeout prevents infinite loops.
     *
     * @param {string} request_url
     * @returns {Promise<Object>} final operation data
     */
    async _cashdro_request_payment(request_url) {
        let pollInterval = CASHDRO_POLL_INITIAL_INTERVAL;
        let consecutiveErrors = 0;
        let attempts = 0;
        const startTime = Date.now();

        while (true) {
            // Global timeout guard
            if (Date.now() - startTime > CASHDRO_POLL_GLOBAL_TIMEOUT) {
                // Time's up, interrupt the CashDro explicitly so it doesn't get stuck waiting for coins forever
                console.error(`[Cashdro] Operation timed out after ${CASHDRO_POLL_GLOBAL_TIMEOUT / 1000}s. Sending cancel...`);
                try {
                     const parser = new URL(request_url);
                     const operationIdMatch = parser.search.match(/operationId=([^&]+)/);
                     if (operationIdMatch && operationIdMatch[1]) {
                         await this.cashdro_finish_operation(operationIdMatch[1]);
                     }
                } catch(e) {
                     console.error("[Cashdro] Failed to send cancel on timeout:", e);
                }
                throw new Error(
                    `Cashdro operation timed out after ${
                        CASHDRO_POLL_GLOBAL_TIMEOUT / 1000
                    }s of polling.`
                );
            }

            attempts++;
            try {
                console.log(
                    `[Cashdro] Polling attempt ${attempts} (interval ${pollInterval}ms)…`
                );
                const data_res = await this._cashdro_fetch(request_url);
                // Reset consecutive error counter on success
                consecutiveErrors = 0;
                console.log(`[Cashdro] Poll response ${attempts}:`, data_res);

                const data = JSON.parse(data_res.data);
                if (data.operation.state === "F") {
                    console.log("[Cashdro] Operation finished!");
                    return data_res;
                }
                console.log(
                    `[Cashdro] Operation state: ${data.operation.state}. Continuing poll…`
                );
            } catch (error) {
                consecutiveErrors++;
                console.warn(
                    `[Cashdro] Poll error ${consecutiveErrors}/${CASHDRO_POLL_MAX_ERRORS}:`,
                    error.message || error
                );
                if (consecutiveErrors >= CASHDRO_POLL_MAX_ERRORS) {
                    console.error(
                        `[Cashdro] ${CASHDRO_POLL_MAX_ERRORS} consecutive poll errors – aborting.`
                    );
                    throw new Error(
                        `Cashdro unreachable after ${CASHDRO_POLL_MAX_ERRORS} consecutive ` +
                            `poll failures. Last error: ${error.message || error}`
                    );
                }
            }

            // Progressive wait: grows each cycle, capped at max
            await new Promise((r) => setTimeout(r, pollInterval));
            pollInterval = Math.min(
                pollInterval + CASHDRO_POLL_INTERVAL_INCREMENT,
                CASHDRO_POLL_MAX_INTERVAL
            );
        }
    }
}
