/** @odoo-module */
/* Copyright 2026 Xtendoo - Manuel Calero
   License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl). */

/**
 * Acción cliente del backend para mostrar el resultado del test de conexión
 * con el datáfono Ingenico AXIUM DX4000.
 *
 * Se activa desde el botón "Test de Conexión" en la configuración del
 * método de pago (pos.payment.method).
 */

import { registry } from "@web/core/registry";
import { Component, xml } from "@odoo/owl";
import { standardActionServiceProps } from "@web/actions/action_service";

class DataphoneTestConnection extends Component {
    static template = xml`
        <div class="o_dataphone_test_result p-4">
            <div t-attf-class="alert #{props.action.params.success ? 'alert-success' : 'alert-danger'} d-flex align-items-center gap-3">
                <span class="fs-2">
                    <t t-if="props.action.params.success">✅</t>
                    <t t-else="">❌</t>
                </span>
                <div>
                    <h5 class="alert-heading mb-1">
                        <t t-if="props.action.params.success">Conexión exitosa</t>
                        <t t-else="">Error de conexión</t>
                    </h5>
                    <p class="mb-0" style="white-space: pre-line;">
                        <t t-esc="props.action.params.message"/>
                    </p>
                </div>
            </div>
            <div class="mt-3 text-muted small">
                <strong>Host:</strong> <t t-esc="props.action.params.host"/> &nbsp;
                <strong>Puerto:</strong> <t t-esc="props.action.params.port"/>
            </div>
        </div>
    `;

    static props = { ...standardActionServiceProps };
}

registry
    .category("actions")
    .add("dataphone_test_connection", DataphoneTestConnection);
