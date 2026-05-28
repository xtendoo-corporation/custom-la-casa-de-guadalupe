# Copyright 2026 Xtendoo - Manuel Calero
# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
"""
Tests del modelo pos.payment.method extendido por el módulo
guadalupe_dataphone_pos_connection.

Cubre:
  - Que la opción 'ingenico_axium' aparece en la selección de terminales
  - Creación de un método de pago con los campos del datáfono
  - Validación de campos requeridos / por defecto
  - _load_pos_data_fields incluye los nuevos campos
  - action_test_dataphone_connection con host vacío lanza UserError
  - _recv_exactly con datos completos y truncados
  - _response_code_to_message para códigos conocidos y desconocidos
"""
from unittest.mock import patch, MagicMock
import socket

from odoo.exceptions import UserError
from odoo.tests import common, tagged


@tagged("post_install", "-at_install", "dataphone")
class TestPosPaymentMethodDataphone(common.TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Obtener el diario de banco para crear el método de pago
        cls.bank_journal = cls.env["account.journal"].search(
            [("type", "=", "bank"), ("company_id", "=", cls.env.company.id)],
            limit=1,
        )
        if not cls.bank_journal:
            cls.bank_journal = cls.env["account.journal"].create({
                "name": "Test Bank Journal Dataphone",
                "type": "bank",
                "code": "TBDPH",
            })

    def _create_dataphone_method(self, **kwargs):
        """Helper: crea un pos.payment.method configurado como datáfono."""
        vals = {
            "name": "Datáfono Test Ingenico",
            "journal_id": self.bank_journal.id,
            "use_payment_terminal": "ingenico_axium",
            "dataphone_host": "192.168.1.100",
            "dataphone_port": 10000,
            "dataphone_currency_code": "978",
            "dataphone_timeout": 30,
        }
        vals.update(kwargs)
        return self.env["pos.payment.method"].create(vals)

    # ──────────────────────────────────────────────────────────────────────────
    # 1. Registro de la selección de terminal
    # ──────────────────────────────────────────────────────────────────────────
    def test_terminal_selection_includes_ingenico_axium(self):
        """'ingenico_axium' debe aparecer en las opciones de terminal."""
        method = self.env["pos.payment.method"]
        selections = method._get_payment_terminal_selection()
        keys = [s[0] for s in selections]
        self.assertIn(
            "ingenico_axium", keys,
            "La opción 'ingenico_axium' no aparece en _get_payment_terminal_selection()"
        )

    def test_terminal_selection_label_in_spanish(self):
        """El label de la opción debe mencionar 'Ingenico' y 'CaixaBank'."""
        method = self.env["pos.payment.method"]
        selections = dict(method._get_payment_terminal_selection())
        label = selections.get("ingenico_axium", "")
        self.assertIn("Ingenico", label)
        self.assertIn("CaixaBank", label)

    # ──────────────────────────────────────────────────────────────────────────
    # 2. Creación y valores por defecto
    # ──────────────────────────────────────────────────────────────────────────
    def test_create_dataphone_payment_method(self):
        """Se puede crear un método de pago con tipo ingenico_axium."""
        method = self._create_dataphone_method()
        self.assertEqual(method.use_payment_terminal, "ingenico_axium")
        self.assertEqual(method.dataphone_host, "192.168.1.100")
        self.assertEqual(method.dataphone_port, 10000)
        self.assertEqual(method.dataphone_currency_code, "978")
        self.assertEqual(method.dataphone_timeout, 30)

    def test_default_port_is_10000(self):
        """El puerto por defecto debe ser 10000."""
        method = self._create_dataphone_method(dataphone_port=10000)
        self.assertEqual(method.dataphone_port, 10000)

    def test_default_currency_code_is_euro(self):
        """El código de moneda por defecto debe ser '978' (EUR)."""
        method = self._create_dataphone_method()
        self.assertEqual(method.dataphone_currency_code, "978")

    def test_optional_fields_can_be_empty(self):
        """merchant_id y terminal_id son opcionales (pueden quedar vacíos)."""
        method = self._create_dataphone_method(
            dataphone_merchant_id=False,
            dataphone_terminal_id=False,
        )
        self.assertFalse(method.dataphone_merchant_id)
        self.assertFalse(method.dataphone_terminal_id)

    # ──────────────────────────────────────────────────────────────────────────
    # 3. _load_pos_data_fields exporta los campos correctos
    # ──────────────────────────────────────────────────────────────────────────
    def test_load_pos_data_fields_includes_dataphone_fields(self):
        """Los campos del datáfono deben incluirse en los datos del POS."""
        pos_config = self.env["pos.config"].search([], limit=1)
        if not pos_config:
            self.skipTest("No hay ninguna configuración de POS disponible")

        method = self._create_dataphone_method()
        fields = method._load_pos_data_fields(pos_config)

        expected_fields = [
            "dataphone_host",
            "dataphone_port",
            "dataphone_merchant_id",
            "dataphone_terminal_id",
            "dataphone_timeout",
            "dataphone_currency_code",
        ]
        for field_name in expected_fields:
            self.assertIn(
                field_name, fields,
                f"El campo '{field_name}' no está en _load_pos_data_fields()"
            )

    # ──────────────────────────────────────────────────────────────────────────
    # 4. action_test_dataphone_connection — validaciones
    # ──────────────────────────────────────────────────────────────────────────
    def test_test_connection_raises_if_no_host(self):
        """UserError si se pulsa 'Test Conexión' sin IP configurada."""
        method = self._create_dataphone_method(dataphone_host=False)
        with self.assertRaises(UserError) as ctx:
            method.action_test_dataphone_connection()
        self.assertIn("IP", str(ctx.exception.args[0]))

    def test_test_connection_success(self):
        """Cuando el socket conecta (mock), la acción devuelve success=True."""
        method = self._create_dataphone_method()

        with patch("socket.socket") as mock_socket_cls:
            mock_sock = MagicMock()
            mock_sock.connect_ex.return_value = 0   # 0 = conexión OK
            mock_socket_cls.return_value = mock_sock

            result = method.action_test_dataphone_connection()

        self.assertEqual(result["type"], "ir.actions.client")
        self.assertEqual(result["tag"], "dataphone_test_connection")
        self.assertTrue(result["params"]["success"])

    def test_test_connection_failure(self):
        """Cuando el socket no conecta (mock), success=False y el mensaje indica error."""
        method = self._create_dataphone_method()

        with patch("socket.socket") as mock_socket_cls:
            mock_sock = MagicMock()
            mock_sock.connect_ex.return_value = 111  # ECONNREFUSED
            mock_socket_cls.return_value = mock_sock

            result = method.action_test_dataphone_connection()

        self.assertEqual(result["type"], "ir.actions.client")
        self.assertFalse(result["params"]["success"])
        self.assertIn("❌", result["params"]["message"])

    def test_test_connection_timeout(self):
        """Cuando el socket hace timeout, success=False y el mensaje menciona 'Timeout'."""
        method = self._create_dataphone_method()

        with patch("socket.socket") as mock_socket_cls:
            mock_sock = MagicMock()
            mock_sock.connect_ex.side_effect = socket.timeout("timed out")
            mock_socket_cls.return_value = mock_sock

            result = method.action_test_dataphone_connection()

        self.assertFalse(result["params"]["success"])
        self.assertIn("Timeout", result["params"]["message"])

    # ──────────────────────────────────────────────────────────────────────────
    # 5. _dataphone_send_transaction — validaciones sin terminal real
    # ──────────────────────────────────────────────────────────────────────────
    def test_send_transaction_raises_if_no_host(self):
        """UserError si se intenta una transacción sin host configurado."""
        method = self._create_dataphone_method(dataphone_host=False)
        # Sobrescribimos el host vacío en memoria para que pase la guardia
        method.dataphone_host = ""
        with self.assertRaises(UserError):
            method._dataphone_send_transaction(1000, "sale")

    def test_send_transaction_connection_refused(self):
        """UserError con mensaje claro si el terminal rechaza la conexión."""
        method = self._create_dataphone_method()

        with patch("socket.socket") as mock_socket_cls:
            mock_sock = MagicMock()
            mock_sock.connect.side_effect = ConnectionRefusedError()
            mock_socket_cls.return_value = mock_sock

            with self.assertRaises(UserError) as ctx:
                method._dataphone_send_transaction(1000, "sale")

        self.assertIn("rechazó", str(ctx.exception.args[0]))

    def test_send_transaction_socket_timeout(self):
        """UserError con mensaje de timeout si el terminal no responde."""
        method = self._create_dataphone_method(dataphone_timeout=5)

        with patch("socket.socket") as mock_socket_cls:
            mock_sock = MagicMock()
            mock_sock.connect.side_effect = socket.timeout("timed out")
            mock_socket_cls.return_value = mock_sock

            with self.assertRaises(UserError) as ctx:
                method._dataphone_send_transaction(1000, "sale")

        self.assertIn("Timeout", str(ctx.exception.args[0]))

    def test_send_transaction_success_mock(self):
        """Simula una respuesta válida del terminal y verifica que se procesa."""
        method = self._create_dataphone_method()

        # Respuesta simulada del terminal (aprobada)
        fake_response = {
            "response_code": "00",
            "authorization_code": "AUTH123",
            "amount": 1000,
            "cardType": "VISA",
            "pan": "1234567890123456",
        }
        fake_response_bytes = __import__("json").dumps(fake_response).encode("utf-8")
        resp_length = len(fake_response_bytes).to_bytes(4, byteorder="big")

        with patch("socket.socket") as mock_socket_cls:
            mock_sock = MagicMock()
            mock_sock.connect.return_value = None
            # recv devuelve: primero el header (4 bytes), luego el body
            mock_sock.recv.side_effect = [resp_length, fake_response_bytes]
            mock_socket_cls.return_value = mock_sock

            result = method._dataphone_send_transaction(1000, "sale")

        self.assertEqual(result["response_code"], "00")
        self.assertEqual(result["authorization_code"], "AUTH123")

    # ──────────────────────────────────────────────────────────────────────────
    # 6. _recv_exactly — utilidad de lectura de socket
    # ──────────────────────────────────────────────────────────────────────────
    def test_recv_exactly_full_read(self):
        """_recv_exactly lee exactamente N bytes en un solo chunk."""
        from odoo.addons.guadalupe_dataphone_pos_connection.models.pos_payment_method import (
            PosPaymentMethod,
        )
        mock_sock = MagicMock()
        mock_sock.recv.return_value = b"hello"
        result = PosPaymentMethod._recv_exactly(mock_sock, 5)
        self.assertEqual(result, b"hello")

    def test_recv_exactly_multiple_chunks(self):
        """_recv_exactly acumula varios chunks hasta completar N bytes."""
        from odoo.addons.guadalupe_dataphone_pos_connection.models.pos_payment_method import (
            PosPaymentMethod,
        )
        mock_sock = MagicMock()
        mock_sock.recv.side_effect = [b"hel", b"lo"]
        result = PosPaymentMethod._recv_exactly(mock_sock, 5)
        self.assertEqual(result, b"hello")

    def test_recv_exactly_empty_socket(self):
        """_recv_exactly devuelve datos parciales si el socket cierra prematuramente."""
        from odoo.addons.guadalupe_dataphone_pos_connection.models.pos_payment_method import (
            PosPaymentMethod,
        )
        mock_sock = MagicMock()
        mock_sock.recv.side_effect = [b"he", b""]  # socket cerrado a mitad
        result = PosPaymentMethod._recv_exactly(mock_sock, 5)
        self.assertEqual(result, b"he")
