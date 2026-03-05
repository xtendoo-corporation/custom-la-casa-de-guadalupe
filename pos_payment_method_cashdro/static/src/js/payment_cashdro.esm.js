/** @odoo-module */
/* Copyright 2021 Tecnativa - David Vidal
   License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).*/
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { _t } from "@web/core/l10n/translation";

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
                throw new Error("No operation ID received from Cashdro");
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
     * Perform a single fetch to the Cashdro device.
     * Does NOT retry – that is handled by the caller.
     *
     * IMPORTANT – Mixed-Content / ERR_CERT_AUTHORITY_INVALID
     * -------------------------------------------------------
     * When Odoo is served over HTTPS the browser will block (or auto-upgrade)
     * plain HTTP requests to the CashDro LAN IP, causing
     * `ERR_CERT_AUTHORITY_INVALID` because the device has no valid TLS cert.
     *
     * To work around this we use XMLHttpRequest which, in some browser
     * configurations, is less aggressively upgraded than fetch().  We also
     * set a generous timeout so the single-threaded CashDro S has time to
     * respond when it is busy counting coins.
     *
     * If the site uses HTTPS you MUST add the CashDro IP to Chrome's
     * Insecure Origins allowlist (see README) or serve the POS over plain HTTP.
     *
     * @param {string} url
     * @returns {Promise<Object>} parsed JSON response
     */
    async _cashdro_fetch(url) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.timeout = 30000; // 30 s – CashDro S can be very slow
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        reject(new Error(`Invalid JSON from CashDro: ${xhr.responseText.substring(0, 200)}`));
                    }
                } else {
                    reject(new Error(`HTTP error! status: ${xhr.status}`));
                }
            };
            xhr.onerror = () => {
                reject(new Error(
                    "Network error connecting to CashDro. " +
                    "If Odoo is served over HTTPS, the browser blocks plain HTTP " +
                    "requests to LAN devices (mixed-content). See README for solutions."
                ));
            };
            xhr.ontimeout = () => {
                reject(new Error("CashDro request timed out (30s)."));
            };
            xhr.send();
        });
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
