/** @odoo-module */
/* Copyright 2026 Xtendoo - Manuel Calero
   License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl). */

import { PaymentDataphone } from "./payment_dataphone.esm";
import { register_payment_method } from "@point_of_sale/app/services/pos_store";

/**
 * Registrar el método de pago "ingenico_axium" en el POS.
 * Este nombre debe coincidir exactamente con el valor definido en
 * _get_payment_terminal_selection() del modelo Python.
 */
register_payment_method("ingenico_axium", PaymentDataphone);

console.log("[Dataphone-LOG] 📌 Método de pago 'ingenico_axium' registrado en el POS.");
