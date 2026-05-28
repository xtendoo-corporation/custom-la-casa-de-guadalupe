# Copyright 2026 Xtendoo - Manuel Calero
# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
"""
Controlador HTTP que actúa como PROXY entre el navegador del TPV
y el terminal físico Ingenico AXIUM DX4000.

Arquitectura:
    Browser (POS JS) ──HTTP POST──► Odoo Server ──TCP Socket──► Datáfono Ingenico

Esto es necesario porque:
1. El browser no puede abrir sockets TCP directos (política de seguridad).
2. El servidor Odoo sí puede comunicarse con el terminal en la red local.
3. El datáfono usa protocolo propietario OPOS/Nexo, no HTTP.
"""
import json
import logging

from odoo import http
from odoo.http import request
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)


class DataphoneController(http.Controller):

    # ────────────────────────────────────────────────────────────────────────
    # Proxy: Iniciar transacción de venta
    # ────────────────────────────────────────────────────────────────────────
    @http.route(
        "/dataphone/transaction/start",
        type="jsonrpc",
        auth="user",
        methods=["POST"],
        csrf=False,
    )
    def transaction_start(self, payment_method_id, amount, transaction_type="sale", **kwargs):
        """
        Inicia una transacción en el datáfono Ingenico.

        :param payment_method_id: ID del pos.payment.method configurado con el datáfono
        :param amount: Importe en céntimos (entero)
        :param transaction_type: 'sale' | 'refund' | 'reversal'
        :return: JSON con el resultado de la transacción
        """
        try:
            payment_method = request.env["pos.payment.method"].browse(int(payment_method_id))
            if not payment_method.exists():
                return {"success": False, "error": "Método de pago no encontrado."}

            if payment_method.use_payment_terminal != "ingenico_axium":
                return {"success": False, "error": "El método de pago no es del tipo Ingenico AXIUM."}

            amount_cents = int(amount)
            if amount_cents <= 0:
                return {"success": False, "error": "El importe debe ser mayor que 0."}

            _logger.info(
                "[Dataphone] Iniciando transacción: tipo=%s importe=%s céntimos método=%s",
                transaction_type, amount_cents, payment_method_id,
            )

            response = payment_method._dataphone_send_transaction(amount_cents, transaction_type)

            # Normalizar la respuesta del terminal
            return self._parse_terminal_response(response)

        except UserError as e:
            _logger.warning("[Dataphone] UserError en transacción: %s", e)
            return {"success": False, "error": str(e.args[0])}
        except Exception as e:
            _logger.error("[Dataphone] Error inesperado en transacción: %s", e, exc_info=True)
            return {"success": False, "error": f"Error interno: {e}"}

    # ────────────────────────────────────────────────────────────────────────
    # Proxy: Cancelar transacción en curso
    # ────────────────────────────────────────────────────────────────────────
    @http.route(
        "/dataphone/transaction/cancel",
        type="jsonrpc",
        auth="user",
        methods=["POST"],
        csrf=False,
    )
    def transaction_cancel(self, payment_method_id, **kwargs):
        """
        Envía señal de cancelación al datáfono.
        """
        try:
            payment_method = request.env["pos.payment.method"].browse(int(payment_method_id))
            if not payment_method.exists():
                return {"success": False, "error": "Método de pago no encontrado."}

            _logger.info("[Dataphone] Cancelando transacción para método=%s", payment_method_id)

            # Enviamos una transacción de anulación
            response = payment_method._dataphone_send_transaction(0, "reversal")
            return self._parse_terminal_response(response)

        except UserError as e:
            return {"success": False, "error": str(e.args[0])}
        except Exception as e:
            _logger.error("[Dataphone] Error al cancelar: %s", e, exc_info=True)
            return {"success": False, "error": f"Error al cancelar: {e}"}

    # ────────────────────────────────────────────────────────────────────────
    # Proxy: Test de conexión (usado desde el backend de configuración)
    # ────────────────────────────────────────────────────────────────────────
    @http.route(
        "/dataphone/test_connection",
        type="jsonrpc",
        auth="user",
        methods=["POST"],
        csrf=False,
    )
    def test_connection(self, host, port, **kwargs):
        """
        Comprueba si el datáfono es accesible desde el servidor Odoo.
        """
        import socket
        try:
            port = int(port) if port else 10000
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            result = sock.connect_ex((host.strip(), port))
            sock.close()
            return {
                "success": result == 0,
                "host": host,
                "port": port,
                "error_code": result if result != 0 else None,
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ────────────────────────────────────────────────────────────────────────
    # Utilidades internas
    # ────────────────────────────────────────────────────────────────────────
    def _parse_terminal_response(self, response):
        """
        Normaliza la respuesta del terminal Ingenico a un formato estándar.

        Los terminales Ingenico AXIUM devuelven campos que pueden variar según
        la versión del firmware y la configuración de Comercia/CaixaBank.
        Aquí normalizamos los más comunes.

        Códigos de respuesta habituales:
            "00" → Aprobada
            "01" → Denegada por el banco
            "05" → No autorizada
            "12" → Transacción inválida
            "51" → Sin fondos
            "55" → PIN incorrecto
            "91" → Banco emisor no disponible (timeout)
            "96" → Incidencia del sistema
        """
        if not response:
            return {"success": False, "error": "El datáfono no devolvió respuesta."}

        # Códigos de éxito (aprobado)
        approval_codes = {"00", "0000", "000000"}

        response_code = str(response.get("response_code", response.get("responseCode", ""))).strip()
        approved = response_code in approval_codes

        return {
            "success": approved,
            "approved": approved,
            "response_code": response_code,
            "authorization_code": response.get("authorization_code", response.get("authCode", "")),
            "amount_authorized": response.get("amount_authorized", response.get("amount", 0)),
            "card_type": response.get("card_type", response.get("cardType", "")),
            "card_last_digits": response.get("card_last_digits", response.get("pan", "")[-4:] if response.get("pan") else ""),
            "ticket_merchant": response.get("ticket_merchant", response.get("ticketMerchant", "")),
            "ticket_customer": response.get("ticket_customer", response.get("ticketCustomer", "")),
            "error": None if approved else (
                response.get("error_message")
                or self._response_code_to_message(response_code)
            ),
        }

    @staticmethod
    def _response_code_to_message(code):
        """Traduce los códigos de respuesta estándar a mensajes en español."""
        messages = {
            "01": "Transacción denegada por el banco emisor.",
            "05": "Tarjeta no autorizada. Contacte con su banco.",
            "12": "Transacción inválida. Inténtelo de nuevo.",
            "14": "Número de tarjeta inválido.",
            "30": "Error de formato. Contacte con soporte técnico.",
            "41": "Tarjeta robada. Retenida.",
            "43": "Tarjeta robada. Retenida.",
            "51": "Fondos insuficientes.",
            "54": "Tarjeta caducada.",
            "55": "PIN incorrecto.",
            "57": "Transacción no permitida para esta tarjeta.",
            "58": "Transacción no permitida para este terminal.",
            "61": "Límite de importe superado.",
            "62": "Tarjeta restringida.",
            "65": "Número de intentos excedido.",
            "75": "Número de intentos de PIN excedido.",
            "91": "El banco emisor no está disponible. Inténtelo más tarde.",
            "96": "Error del sistema. Inténtelo de nuevo.",
        }
        return messages.get(str(code), f"Error desconocido (código: {code}). Consulte con CaixaBank.")
