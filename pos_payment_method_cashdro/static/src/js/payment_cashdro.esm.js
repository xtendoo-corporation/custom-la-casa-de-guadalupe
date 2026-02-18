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
        try {
            // Cashdro treats decimals as positions in an integer we also have
            // to deal with floating point computing to avoid decimals at the
            // end or the drawer will reject our request.
            const amount = Math.round(order.remainingDue * 100);
            const res = await this._cashdro_request(
                this._cashdro_payment_url({ amount: amount })
            );
            // It comes handy to log the response from the drawer, as
            // we can diagnose the right sytmoms for each issue
            console.log(res);
            const operation_id = res.data || "";
            this.pos.getOrder().cashdro_operation = operation_id;
            // Acknowledge the operation
            var ack_url = this._cashdro_ack_url(operation_id);
            const res_ack = await this._cashdro_request(ack_url);
            // Validate the operation
            console.log(res_ack);
            var ask_url = this._cashdro_ask_url(operation_id);
            const operation_data = await this._cashdro_request_payment(ask_url);
            // This might be too verbose, but it helps a lot to diagnose issues and
            // their reasons.
            console.log(operation_data);
            var data = JSON.parse(operation_data.data);
            payment_line.cashdro_operation_data = data;
            var tendered = data.operation.totalin / 100;
            payment_line.setAmount(tendered);
        } catch (error) {
            // We wan't to be able to retry after any error.
            payment_line.setPaymentStatus("retry");
            this.env.services.dialog.add(AlertDialog, {
                title: _t("Error"),
                body: _t("An error occurred while connecting to the cashdro."),
            });
            return false;
        }
        return true;
    }

    async cashdro_finish_operation(operation) {
        // Finish the Cashdro running operation
        var order = this.pos.getOrder();
        if (operation) {
            await this._cashdro_request(this._cashdro_finish_url(operation));
            order.cashdro_operation = false;
        }
    }

    // API communication methods

    _cashdro_url() {
        // Cashdro machines don't support safe POST calls, so we're sending
        // all the data quite unsafely constantly...
        const method = this.pos.getOrder().getSelectedPaymentline().payment_method_id;
        const host = method && method.cashdro_host;
        if (!host) {
            return false;
        }
        let url = `${host}/Cashdro3WS/index.php`;
        url += `?name=${method.cashdro_user}`;
        url += `&password=${method.cashdro_password}`;
        return url;
    }

    _cashdro_payment_url(parameters) {
        // Compose the url for a sale report to Cashdro
        const user = this.pos.cashier.id || this.pos.user.id;
        // Type 4 for payment, 3 for refund
        const operationType = parameters.amount > 0 ? 4 : 3;
        parameters = { ...parameters, amount: Math.abs(parameters.amount) };
        let url = `${this._cashdro_url()}&operation=startOperation&type=${operationType}`;
        url += `&posid=pos-${this.pos.session.name}`;
        url += `&posuser=${user}`;
        url += `&parameters=${encodeURIComponent(JSON.stringify(parameters))}`;
        return url;
    }

    _cashdro_ack_url(operation_id) {
        // Compose the url for a sale report to Cashdro
        var url = this._cashdro_url();
        url += "&operation=acknowledgeOperationId";
        url += "&operationId=" + operation_id;
        return url;
    }

    _cashdro_ask_url(operation_id) {
        // Compose the url for to report a sale to Cashdro
        var url = this._cashdro_url();
        url += "&operation=askOperation";
        url += "&operationId=" + operation_id;
        return url;
    }

    _cashdro_finish_url(operation_id) {
        // Compose the url for a sale report to Cashdro
        var url = this._cashdro_url();
        url += "&operation=finishOperation&type=2";
        url += "&operationId=" + operation_id;
        return url;
    }

    async _cashdro_request(url) {
        // We'll use it for regular requests
        const response = await browser.fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    }

    /**
     * This is a special request, as we keep requesting the CashDro  until we get
     * the *finished* state that will give us the amount received in the cashdrawer.
     *
     * @param {String} request_url
     * @returns promise
     */
    async _cashdro_request_payment(request_url) {
        while (true) {
            try {
                const response = await browser.fetch(request_url);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data_res = await response.json();
                const data = JSON.parse(data_res.data);
                if (data.operation.state === "F") {
                    return data_res;
                }
            } catch (error) {
                console.error("Error in Cashdro request payment loop:", error);
                throw error;
            }
            // Wait a bit before retrying to avoid hammering the terminal
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
}
