/** @odoo-module */
/* Copyright 2021 Tecnativa - David Vidal
   License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).*/
import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { PaymentCashdro } from "./payment_cashdro.esm";
import { patch } from "@web/core/utils/patch";
import { register_payment_method } from "@point_of_sale/app/services/pos_store";

register_payment_method("cashdro", PaymentCashdro);

patch(PosOrder.prototype, {
    setup() {
        super.setup(...arguments);
        this.in_cashdro_transaction = false;
    },
    /**
     * @override
     * Set the amount to 0 as it's going to be filled by the Cashdro response
     */
    addPaymentline() {
        const line = super.addPaymentline(...arguments);
        if (!line) {
            return line;
        }
        if (
            line.payment_method_id &&
            line.payment_method_id.use_payment_terminal === "cashdro" &&
            line.amount > 0 // For refund transactions we need to keep the amount
        ) {
            line.setAmount(0);
        }
        return line;
    },
});
