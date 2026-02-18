/** @odoo-module */
/* Copyright 2021 Tecnativa - David Vidal
   License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).*/
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { _t } from "@web/core/l10n/translation";
import { browser } from "@web/core/browser/browser";

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

            // Validate the operation
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
                body: _t("An error occurred while connecting to the cashdro: %s", error.message || error),
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

    // API communication methods

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
            console.error("[Cashdro] Cashdro host is missing in payment method configuration");
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
        let url = base_url;
        url += "&operation=acknowledgeOperationId";
        url += "&operationId=" + operation_id;
        return url;
    }

    _cashdro_ask_url(operation_id) {
        const base_url = this._cashdro_url();
        if (!base_url) return "";
        let url = base_url;
        url += "&operation=askOperation";
        url += "&operationId=" + operation_id;
        return url;
    }

    _cashdro_finish_url(operation_id) {
        const base_url = this._cashdro_url();
        if (!base_url) return "";
        let url = base_url;
        url += "&operation=finishOperation&type=2";
        url += "&operationId=" + operation_id;
        return url;
    }

    /**
     * Replaces fetch with XMLHttpRequest to avoid Odoo Service Worker 
     * automatic protocol upgrades (HTTP -> HTTPS) and interception.
     */
    async _cashdro_request(url) {
        console.log("[Cashdro] Requesting via XHR:", url);
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.timeout = 15000;
            
            xhr.onload = function () {
                console.log("[Cashdro] XHR Status:", xhr.status);
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        console.log("[Cashdro] XHR Response data:", data);
                        resolve(data);
                    } catch (e) {
                        console.log("[Cashdro] XHR raw response:", xhr.responseText);
                        resolve({ data: xhr.responseText });
                    }
                } else {
                    reject(new Error(`XHR error! status: ${xhr.status}`));
                }
            };
            
            xhr.onerror = function () {
                console.error("[Cashdro] XHR Network Error");
                reject(new Error("XHR Network Error (Protocol blocked or destination unreachable)"));
            };
            
            xhr.ontimeout = function () {
                console.error("[Cashdro] XHR Timeout");
                reject(new Error("XHR Timeout"));
            };
            
            xhr.send();
        });
    }

    /**
     * Special request loop using XHR to bypass Service Worker limits.
     */
    async _cashdro_request_payment(request_url) {
        let attempts = 0;
        while (true) {
            attempts++;
            try {
                console.log(`[Cashdro] Polling attempt ${attempts} via XHR...`);
                const data_res = await this._cashdro_request(request_url);
                console.log(`[Cashdro] Poll response ${attempts}:`, data_res);
                const data = JSON.parse(data_res.data);
                if (data.operation.state === "F") {
                    console.log("[Cashdro] Operation finished!");
                    return data_res;
                }
                console.log(`[Cashdro] Operation state: ${data.operation.state}. Continuing poll...`);
            } catch (error) {
                console.error("[Cashdro] Error in XHR poll loop:", error);
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
}
