import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { useAsyncLockedMethod } from "@point_of_sale/app/hooks/hooks";
import { patch } from "@web/core/utils/patch";

patch(ControlButtons.prototype, {
    setup() {
        super.setup(...arguments);
        this.clickPrintPreticket = useAsyncLockedMethod(this.clickPrintPreticket);
    },
    async clickPrintPreticket() {
        await this.pos.printReceipt({
            printBillActionTriggered: true,
        });
    },
});
