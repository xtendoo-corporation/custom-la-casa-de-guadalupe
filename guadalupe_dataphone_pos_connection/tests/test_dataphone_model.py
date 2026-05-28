# Copyright 2026 Xtendoo - Manuel Calero
# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
"""
Tests de integración del modelo PosPaymentMethod.

Cubre casos de extremo a extremo sin terminal real:
  - Módulo se instala y los campos existen en la BD
  - Write / lectura de todos los campos del datáfono
  - El método de pago no interfiere con otros tipos de terminal
  - Construcción del mensaje TCP (formato correcto)
  - Seguridad: usuario sin permisos no puede escribir
"""
import json
from unittest.mock import patch, MagicMock

from odoo.exceptions import UserError, AccessError
from odoo.tests import common, tagged


@tagged("post_install", "-at_install", "dataphone")
class TestDataphoneModel(common.TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.bank_journal = cls.env["account.journal"].search(
            [("type", "=", "bank"), ("company_id", "=", cls.env.company.id)],
            limit=1,
        )
        if not cls.bank_journal:
            cls.bank_journal = cls.env["account.journal"].create({
                "name": "Test Bank Journal DPH2",
                "type": "bank",
                "code": "TBDP2",
            })

    def _create_method(self, **extra):
        vals = {
            "name": "Datáfono Ingenico Test",
            "journal_id": self.bank_journal.id,
            "use_payment_terminal": "ingenico_axium",
            "dataphone_host": "10.0.0.1",
            "dataphone_port": 10000,
            "dataphone_currency_code": "978",
            "dataphone_timeout": 30,
        }
        vals.update(extra)
        return self.env["pos.payment.method"].create(vals)

    # ──────────────────────────────────────────────────────────────────────────
    # 1. Los campos existen en la base de datos
    # ──────────────────────────────────────────────────────────────────────────
    def test_fields_exist_in_model(self):
        """Todos los campos custom del datáfono existen en pos.payment.method."""
        model_fields = self.env["pos.payment.method"]._fields
        expected = [
            "dataphone_host",
            "dataphone_port",
            "dataphone_merchant_id",
            "dataphone_terminal_id",
            "dataphone_timeout",
            "dataphone_currency_code",
        ]
        for fname in expected:
            self.assertIn(fname, model_fields, f"Campo '{fname}' no encontrado en el modelo")

    # ──────────────────────────────────────────────────────────────────────────
    # 2. Lectura / escritura de campos
    # ──────────────────────────────────────────────────────────────────────────
    def test_write_and_read_all_dataphone_fields(self):
        """Se pueden escribir y leer todos los campos sin error."""
        method = self._create_method(
            dataphone_host="192.168.0.50",
            dataphone_port=9999,
            dataphone_merchant_id="MERCHANT123",
            dataphone_terminal_id="TERMINAL01",
            dataphone_timeout=60,
            dataphone_currency_code="978",
        )
        method.write({
            "dataphone_host": "192.168.0.99",
            "dataphone_port": 8888,
            "dataphone_merchant_id": "MERCHANT999",
            "dataphone_terminal_id": "TERM999",
            "dataphone_timeout": 45,
            "dataphone_currency_code": "840",
        })
        self.assertEqual(method.dataphone_host, "192.168.0.99")
        self.assertEqual(method.dataphone_port, 8888)
        self.assertEqual(method.dataphone_merchant_id, "MERCHANT999")
        self.assertEqual(method.dataphone_terminal_id, "TERM999")
        self.assertEqual(method.dataphone_timeout, 45)
        self.assertEqual(method.dataphone_currency_code, "840")

    # ──────────────────────────────────────────────────────────────────────────
    # 3. No interfiere con otros terminales
    # ──────────────────────────────────────────────────────────────────────────
    def test_dataphone_fields_are_empty_for_other_terminal_types(self):
        """Los campos del datáfono deben estar vacíos para otros tipos de terminal."""
        # Comprobamos que un método sin terminal no tiene host del datáfono
        plain_method = self.env["pos.payment.method"].create({
            "name": "Pago en efectivo test",
            "journal_id": self.bank_journal.id,
        })
        self.assertFalse(plain_method.dataphone_host)
        self.assertFalse(plain_method.dataphone_merchant_id)

    def test_ingenico_terminal_does_not_affect_cash_method(self):
        """Crear un método Ingenico no altera los métodos de pago en efectivo existentes."""
        cash_journal = self.env["account.journal"].search(
            [("type", "=", "cash"), ("company_id", "=", self.env.company.id)],
            limit=1,
        )
        if not cash_journal:
            self.skipTest("No hay diario de caja disponible")

        cash_method = self.env["pos.payment.method"].search(
            [("journal_id", "=", cash_journal.id)], limit=1
        )
        if not cash_method:
            self.skipTest("No hay método de pago en caja disponible")

        original_terminal = cash_method.use_payment_terminal
        # Crear el método Ingenico
        self._create_method()
        # El método en caja no debe haberse modificado
        self.assertEqual(cash_method.use_payment_terminal, original_terminal)

    # ──────────────────────────────────────────────────────────────────────────
    # 4. Construcción del mensaje TCP
    # ──────────────────────────────────────────────────────────────────────────
    def test_transaction_message_format(self):
        """El mensaje enviado al terminal debe tener el formato JSON correcto."""
        method = self._create_method(
            dataphone_merchant_id="MERCH01",
            dataphone_terminal_id="TERM01",
            dataphone_currency_code="978",
        )

        captured_data = {}

        def fake_sendall(data):
            # Los primeros 4 bytes son el header de longitud
            body_length = int.from_bytes(data[:4], byteorder="big")
            body = json.loads(data[4:4 + body_length].decode("utf-8"))
            captured_data.update(body)

        with patch("socket.socket") as mock_socket_cls:
            mock_sock = MagicMock()
            mock_sock.connect.return_value = None
            mock_sock.sendall.side_effect = fake_sendall
            # Simular que el terminal responde con aprobación
            fake_resp = json.dumps({"response_code": "00"}).encode("utf-8")
            mock_sock.recv.side_effect = [
                len(fake_resp).to_bytes(4, byteorder="big"),
                fake_resp,
            ]
            mock_socket_cls.return_value = mock_sock
            method._dataphone_send_transaction(2500, "sale")

        # Verificar estructura del mensaje
        self.assertIn("operation", captured_data)
        self.assertIn("amount", captured_data)
        self.assertIn("currency", captured_data)
        self.assertEqual(captured_data["operation"], "00")       # sale = "00"
        self.assertEqual(captured_data["amount"], "000000002500")  # 12 dígitos
        self.assertEqual(captured_data["currency"], "978")
        self.assertEqual(captured_data["merchant_id"], "MERCH01")
        self.assertEqual(captured_data["terminal_id"], "TERM01")

    def test_transaction_operation_codes(self):
        """Los tipos de transacción mapean a los códigos correctos."""
        method = self._create_method()
        codes = {"sale": "00", "refund": "01", "reversal": "02"}

        for tx_type, expected_code in codes.items():
            captured = {}

            def fake_sendall(data, _code=expected_code):
                body = json.loads(data[4:].decode("utf-8"))
                captured["op"] = body.get("operation")

            with patch("socket.socket") as mock_socket_cls:
                mock_sock = MagicMock()
                mock_sock.connect.return_value = None
                mock_sock.sendall.side_effect = fake_sendall
                fake_resp = json.dumps({"response_code": "00"}).encode("utf-8")
                mock_sock.recv.side_effect = [
                    len(fake_resp).to_bytes(4, byteorder="big"),
                    fake_resp,
                ]
                mock_socket_cls.return_value = mock_sock
                method._dataphone_send_transaction(100, tx_type)

            with self.subTest(transaction_type=tx_type):
                self.assertEqual(
                    captured["op"], expected_code,
                    f"Tipo '{tx_type}' debería mapear a código '{expected_code}', "
                    f"pero se envió '{captured.get('op')}'"
                )

    def test_amount_always_12_digits(self):
        """El importe siempre se envía con exactamente 12 dígitos."""
        method = self._create_method()
        test_amounts = [1, 99, 1000, 999999, 10000000]

        for amount in test_amounts:
            captured = {}

            def fake_sendall(data):
                body = json.loads(data[4:].decode("utf-8"))
                captured["amount"] = body.get("amount", "")

            with patch("socket.socket") as mock_socket_cls:
                mock_sock = MagicMock()
                mock_sock.connect.return_value = None
                mock_sock.sendall.side_effect = fake_sendall
                fake_resp = json.dumps({"response_code": "00"}).encode("utf-8")
                mock_sock.recv.side_effect = [
                    len(fake_resp).to_bytes(4, byteorder="big"),
                    fake_resp,
                ]
                mock_socket_cls.return_value = mock_sock
                method._dataphone_send_transaction(amount, "sale")

            with self.subTest(amount=amount):
                self.assertEqual(
                    len(captured["amount"]), 12,
                    f"El importe {amount} debe tener 12 dígitos, "
                    f"pero tiene {len(captured.get('amount', ''))}"
                )

    def test_pos_user_cannot_write_payment_method(self):
        """Un usuario de TPV (sin rol de manager) no puede modificar métodos de pago."""
        method = self._create_method()
        pos_user = self.env["res.users"].sudo().create({
            "name": "Test POS User Dataphone",
            "login": "test_pos_user_dph_001",
            "group_ids": [
                (4, self.env.ref("base.group_user").id),
                (4, self.env.ref("point_of_sale.group_pos_user").id),
            ],
        })
        method_as_user = method.with_user(pos_user)
        with self.assertRaises(AccessError):
            method_as_user.write({"dataphone_host": "evil.host.com"})

    def test_pos_manager_can_write_payment_method(self):
        """Un manager del POS sí puede modificar métodos de pago."""
        method = self._create_method()
        pos_manager = self.env["res.users"].sudo().create({
            "name": "Test POS Manager Dataphone",
            "login": "test_pos_manager_dph_001",
            "group_ids": [
                (4, self.env.ref("base.group_user").id),
                (4, self.env.ref("point_of_sale.group_pos_manager").id),
            ],
        })
        method_as_manager = method.with_user(pos_manager)
        # No debe lanzar excepción
        method_as_manager.write({"dataphone_host": "192.168.1.200"})
        self.assertEqual(method.dataphone_host, "192.168.1.200")
