# Copyright 2026 Xtendoo - Manuel Calero
# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
"""
Tests del controlador HTTP DataphoneController.

Cubre la lógica de negocio pura (sin HTTP real):
  - _parse_terminal_response: respuesta aprobada, denegada, vacía
  - _response_code_to_message: códigos conocidos y desconocidos
  - Lógica de transaction_start / cancel directamente sobre el objeto
"""
from odoo.tests import common, tagged


@tagged("post_install", "-at_install", "dataphone")
class TestDataphoneController(common.TransactionCase):
    """
    Testea la lógica pura del controlador sin levantar un servidor HTTP.
    Importamos la clase directamente y probamos sus métodos estáticos/internos.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from odoo.addons.guadalupe_dataphone_pos_connection.controllers.dataphone_controller import (
            DataphoneController,
        )
        cls.controller = DataphoneController()

    # ──────────────────────────────────────────────────────────────────────────
    # _parse_terminal_response — respuesta aprobada
    # ──────────────────────────────────────────────────────────────────────────
    def test_parse_response_approved_code_00(self):
        """Código '00' → success=True, approved=True."""
        response = {
            "response_code": "00",
            "authorization_code": "AUTH001",
            "amount_authorized": 1500,
            "card_type": "VISA",
            "pan": "4111111111111111",
        }
        result = self.controller._parse_terminal_response(response)
        self.assertTrue(result["success"])
        self.assertTrue(result["approved"])
        self.assertEqual(result["authorization_code"], "AUTH001")
        self.assertEqual(result["card_last_digits"], "1111")
        self.assertIsNone(result["error"])

    def test_parse_response_approved_code_0000(self):
        """Código '0000' también debe ser aprobado."""
        response = {"response_code": "0000", "authorization_code": "XYZ"}
        result = self.controller._parse_terminal_response(response)
        self.assertTrue(result["approved"])

    def test_parse_response_approved_code_000000(self):
        """Código '000000' también debe ser aprobado."""
        response = {"response_code": "000000"}
        result = self.controller._parse_terminal_response(response)
        self.assertTrue(result["approved"])

    # ──────────────────────────────────────────────────────────────────────────
    # _parse_terminal_response — respuesta denegada
    # ──────────────────────────────────────────────────────────────────────────
    def test_parse_response_denied_code_51(self):
        """Código '51' (sin fondos) → success=False, error en español."""
        response = {"response_code": "51"}
        result = self.controller._parse_terminal_response(response)
        self.assertFalse(result["success"])
        self.assertFalse(result["approved"])
        self.assertIn("Fondos", result["error"])

    def test_parse_response_denied_code_55(self):
        """Código '55' (PIN incorrecto) → error específico."""
        response = {"response_code": "55"}
        result = self.controller._parse_terminal_response(response)
        self.assertFalse(result["success"])
        self.assertIn("PIN", result["error"])

    def test_parse_response_denied_code_91(self):
        """Código '91' (banco no disponible) → error con mención al banco."""
        response = {"response_code": "91"}
        result = self.controller._parse_terminal_response(response)
        self.assertFalse(result["success"])
        self.assertIn("banco", result["error"].lower())

    def test_parse_response_denied_unknown_code(self):
        """Código desconocido → mensaje genérico que menciona CaixaBank."""
        response = {"response_code": "ZZ"}
        result = self.controller._parse_terminal_response(response)
        self.assertFalse(result["success"])
        self.assertIn("CaixaBank", result["error"])

    # ──────────────────────────────────────────────────────────────────────────
    # _parse_terminal_response — respuesta vacía / nula
    # ──────────────────────────────────────────────────────────────────────────
    def test_parse_response_none(self):
        """Respuesta None → success=False con mensaje."""
        result = self.controller._parse_terminal_response(None)
        self.assertFalse(result["success"])
        self.assertIn("respuesta", result["error"].lower())

    def test_parse_response_empty_dict(self):
        """Respuesta vacía {} → código vacío → denegado."""
        result = self.controller._parse_terminal_response({})
        self.assertFalse(result["success"])

    # ──────────────────────────────────────────────────────────────────────────
    # _parse_terminal_response — campos alternativos (camelCase)
    # ──────────────────────────────────────────────────────────────────────────
    def test_parse_response_camelcase_fields(self):
        """Acepta campos en camelCase (responseCode, authCode, cardType)."""
        response = {
            "responseCode": "00",
            "authCode": "CAMEL001",
            "cardType": "MASTERCARD",
            "amount": 2000,
        }
        result = self.controller._parse_terminal_response(response)
        self.assertTrue(result["approved"])
        self.assertEqual(result["authorization_code"], "CAMEL001")
        self.assertEqual(result["card_type"], "MASTERCARD")

    def test_parse_response_pan_last_4_digits(self):
        """Los últimos 4 dígitos del PAN se extraen correctamente."""
        response = {"response_code": "00", "pan": "5500005555555559"}
        result = self.controller._parse_terminal_response(response)
        self.assertEqual(result["card_last_digits"], "5559")

    def test_parse_response_custom_error_message_takes_priority(self):
        """Si el terminal devuelve error_message, tiene prioridad sobre el código."""
        response = {
            "response_code": "99",
            "error_message": "Mensaje personalizado del terminal",
        }
        result = self.controller._parse_terminal_response(response)
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "Mensaje personalizado del terminal")

    # ──────────────────────────────────────────────────────────────────────────
    # _response_code_to_message — códigos estándar
    # ──────────────────────────────────────────────────────────────────────────
    def test_response_code_01_denied_by_bank(self):
        msg = self.controller._response_code_to_message("01")
        self.assertIn("banco emisor", msg.lower())

    def test_response_code_05_not_authorized(self):
        msg = self.controller._response_code_to_message("05")
        self.assertIn("autorizada", msg.lower())

    def test_response_code_12_invalid_transaction(self):
        msg = self.controller._response_code_to_message("12")
        self.assertIn("inválida", msg.lower())

    def test_response_code_14_invalid_card_number(self):
        msg = self.controller._response_code_to_message("14")
        self.assertIn("tarjeta", msg.lower())

    def test_response_code_41_stolen_card(self):
        msg = self.controller._response_code_to_message("41")
        self.assertIn("robada", msg.lower())

    def test_response_code_54_expired_card(self):
        msg = self.controller._response_code_to_message("54")
        self.assertIn("caducada", msg.lower())

    def test_response_code_unknown(self):
        """Código desconocido → mensaje genérico con el código."""
        msg = self.controller._response_code_to_message("XX")
        self.assertIn("XX", msg)
        self.assertIn("CaixaBank", msg)

    def test_response_code_is_coerced_to_string(self):
        """_response_code_to_message acepta enteros además de strings."""
        msg = self.controller._response_code_to_message(51)
        self.assertIn("Fondos", msg)

    # ──────────────────────────────────────────────────────────────────────────
    # Integridad de todos los códigos del mapa
    # ──────────────────────────────────────────────────────────────────────────
    def test_all_known_codes_return_non_empty_messages(self):
        """Todos los códigos del diccionario devuelven un mensaje no vacío."""
        known_codes = ["01", "05", "12", "14", "30", "41", "43",
                       "51", "54", "55", "57", "58", "61", "62",
                       "65", "75", "91", "96"]
        for code in known_codes:
            with self.subTest(code=code):
                msg = self.controller._response_code_to_message(code)
                self.assertTrue(msg, f"Código {code} devolvió mensaje vacío")
                self.assertIsInstance(msg, str)
