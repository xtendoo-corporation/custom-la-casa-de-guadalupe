# Copyright 2026 Xtendoo - Manuel Calero
# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
import logging
import socket
import json
import threading
import time

from odoo import api, fields, models, _
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# ────────────────────────────────────────────────────────────────────────────
# Constantes de comunicación con el datáfono Ingenico AXIUM DX4000
# Protocolo: Nexo-Retailer / OPOS via TCP Socket
# ────────────────────────────────────────────────────────────────────────────
DATAPHONE_DEFAULT_PORT = 10000       # Puerto TCP por defecto del terminal Ingenico
DATAPHONE_SOCKET_TIMEOUT = 30        # Segundos de timeout para operaciones normales
DATAPHONE_CONNECT_TIMEOUT = 10       # Segundos de timeout para conectar
DATAPHONE_TEST_TIMEOUT = 5           # Timeout para test de conexión


class PosPaymentMethod(models.Model):
    _inherit = "pos.payment.method"

    # ────────────────────────────────────────────────────────────────────────
    # Campos específicos del datáfono Ingenico AXIUM DX4000
    # ────────────────────────────────────────────────────────────────────────
    def _get_payment_terminal_selection(self):
        return super()._get_payment_terminal_selection() + [
            ("ingenico_axium", "Datáfono Ingenico AXIUM (CaixaBank)")
        ]

    dataphone_host = fields.Char(
        string="IP del Datáfono",
        help=(
            "Dirección IP del terminal Ingenico AXIUM DX4000 en la red local. "
            "Puedes verla en el terminal: Menú → Configuración → Red → Información."
        ),
    )
    dataphone_port = fields.Integer(
        string="Puerto TCP",
        default=DATAPHONE_DEFAULT_PORT,
        help=(
            "Puerto TCP del terminal. Por defecto 10000 para terminales Ingenico "
            "con protocolo OPOS/Nexo. Consulta con CaixaBank si fuese diferente."
        ),
    )
    dataphone_merchant_id = fields.Char(
        string="ID Comercio (Merchant ID)",
        help=(
            "Identificador del comercio proporcionado por CaixaBank/Comercia. "
            "Aparece en el contrato TPV. Opcional: solo si el terminal lo requiere."
        ),
    )
    dataphone_terminal_id = fields.Char(
        string="ID Terminal",
        help=(
            "Número de identificación del terminal (TID). "
            "Aparece en el contrato o en la etiqueta del terminal."
        ),
    )
    dataphone_timeout = fields.Integer(
        string="Timeout (segundos)",
        default=DATAPHONE_SOCKET_TIMEOUT,
        help="Tiempo máximo de espera para que el cliente introduzca su tarjeta.",
    )
    dataphone_currency_code = fields.Char(
        string="Código de Moneda ISO 4217",
        default="978",
        help="Código numérico ISO 4217 de la moneda. 978 = EUR.",
    )

    # ────────────────────────────────────────────────────────────────────────
    # Exportar campos al frontend POS
    # ────────────────────────────────────────────────────────────────────────
    @api.model
    def _load_pos_data_fields(self, config):
        params = super()._load_pos_data_fields(config)
        params += [
            "dataphone_host",
            "dataphone_port",
            "dataphone_merchant_id",
            "dataphone_terminal_id",
            "dataphone_timeout",
            "dataphone_currency_code",
        ]
        return params

    # ────────────────────────────────────────────────────────────────────────
    # Botón de test de conexión (backend → terminal via proxy del servidor)
    # ────────────────────────────────────────────────────────────────────────
    def action_test_dataphone_connection(self):
        """
        Prueba la conectividad con el terminal Ingenico AXIUM DX4000.
        El servidor Odoo actúa como proxy hacia el terminal.
        Devuelve una client action para mostrar el resultado en el navegador.
        """
        self.ensure_one()
        if not self.dataphone_host:
            raise UserError(_("La IP del Datáfono no está configurada."))

        host = self.dataphone_host.strip()
        port = self.dataphone_port or DATAPHONE_DEFAULT_PORT

        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(DATAPHONE_TEST_TIMEOUT)
            result = sock.connect_ex((host, port))
            sock.close()

            if result == 0:
                message = _(
                    "✅ Conexión exitosa con el datáfono Ingenico AXIUM DX4000\n"
                    "Host: %s  Puerto: %s\n"
                    "El terminal es accesible desde el servidor Odoo."
                ) % (host, port)
                success = True
            else:
                message = _(
                    "❌ No se pudo conectar con el datáfono.\n"
                    "Host: %s  Puerto: %s  Código de error: %s\n"
                    "Comprueba que el terminal está encendido y en la misma red."
                ) % (host, port, result)
                success = False

        except socket.timeout:
            message = _(
                "❌ Timeout de conexión con el datáfono.\n"
                "Host: %s  Puerto: %s\n"
                "El terminal no responde en %s segundos."
            ) % (host, port, DATAPHONE_TEST_TIMEOUT)
            success = False
        except Exception as e:
            message = _("❌ Error inesperado: %s") % str(e)
            success = False

        return {
            "type": "ir.actions.client",
            "tag": "dataphone_test_connection",
            "params": {
                "host": host,
                "port": port,
                "success": success,
                "message": message,
            },
        }

    # ────────────────────────────────────────────────────────────────────────
    # Métodos de comunicación con el terminal (usados por el controlador HTTP)
    # ────────────────────────────────────────────────────────────────────────
    def _dataphone_send_transaction(self, amount_cents, transaction_type="sale"):
        """
        Envía una transacción al terminal Ingenico AXIUM DX4000 via TCP socket.

        Protocolo: Nexo-Retailer simplificado (compatible con terminales Comercia/CaixaBank)
        El mensaje se envía como JSON con longitud de cabecera.

        :param amount_cents: Importe en céntimos (int)
        :param transaction_type: 'sale' | 'refund' | 'reversal'
        :return: dict con el resultado de la transacción
        """
        self.ensure_one()
        host = self.dataphone_host.strip()
        port = self.dataphone_port or DATAPHONE_DEFAULT_PORT
        timeout = self.dataphone_timeout or DATAPHONE_SOCKET_TIMEOUT

        # Construir mensaje según protocolo OPOS/Nexo para terminales Ingenico
        transaction_map = {
            "sale": "00",       # Venta
            "refund": "01",     # Devolución
            "reversal": "02",   # Anulación
        }
        op_code = transaction_map.get(transaction_type, "00")

        # Formato del mensaje: compatible con protocolo de integración CaixaBank
        message = {
            "operation": op_code,
            "amount": str(amount_cents).zfill(12),         # 12 dígitos, céntimos
            "currency": self.dataphone_currency_code or "978",
            "merchant_id": self.dataphone_merchant_id or "",
            "terminal_id": self.dataphone_terminal_id or "",
        }

        message_bytes = json.dumps(message).encode("utf-8")
        # Cabecera: 4 bytes con la longitud del mensaje (big-endian)
        header = len(message_bytes).to_bytes(4, byteorder="big")

        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            sock.connect((host, port))
            sock.sendall(header + message_bytes)

            # Leer respuesta: cabecera (4 bytes) + cuerpo
            raw_header = self._recv_exactly(sock, 4)
            if not raw_header or len(raw_header) < 4:
                raise Exception("Respuesta inválida: cabecera truncada")

            resp_length = int.from_bytes(raw_header, byteorder="big")
            raw_body = self._recv_exactly(sock, resp_length)
            sock.close()

            response = json.loads(raw_body.decode("utf-8"))
            _logger.info(
                "[Dataphone] Respuesta del terminal %s:%s → %s", host, port, response
            )
            return response

        except socket.timeout:
            raise UserError(
                _("Timeout esperando respuesta del datáfono (%s segundos). "
                  "El cliente puede no haber introducido la tarjeta a tiempo.") % timeout
            )
        except ConnectionRefusedError:
            raise UserError(
                _("El datáfono rechazó la conexión. "
                  "Comprueba que el terminal está en modo POS y accesible en %s:%s.") % (host, port)
            )
        except Exception as e:
            _logger.error("[Dataphone] Error de comunicación: %s", e)
            raise UserError(_("Error de comunicación con el datáfono: %s") % str(e))

    @staticmethod
    def _recv_exactly(sock, num_bytes):
        """Lee exactamente num_bytes del socket."""
        data = b""
        while len(data) < num_bytes:
            chunk = sock.recv(num_bytes - len(data))
            if not chunk:
                break
            data += chunk
        return data
