import { Command, Plugin, TitlebarItem } from "@opencode/plugin/gui";
import { createComponent } from "solid-js";
import { DashboardFrame } from "./gui-frame";
import { dashboardMessages } from "./gui-messages";
import { Page, Pages } from "./gui-pages";
export default Plugin.define({
    i18n: dashboardMessages,
    setup(ctx) {
        const pages = ctx.use(Pages);
        ctx.add(Page, { id: "dashboard", title: "Runmark", icon: "window-analytics", render: () => createComponent(DashboardFrame, {}) });
        const open = () => {
            if (ctx.layout.narrow())
                return;
            const live = pages();
            if (live.status !== "active" || !live.value.open("dashboard"))
                ctx.toast.show({ variant: "error", title: ctx.t("failed") });
        };
        ctx.add(TitlebarItem, () => {
            if (ctx.layout.narrow())
                return;
            const live = pages();
            return {
                id: "dashboard",
                label: "Runmark",
                title: ctx.t("open"),
                icon: "window-analytics",
                pressed: live.status === "active" && live.value.current() === "dashboard",
                run: () => void open(),
            };
        });
        ctx.add(Command, () => ({
            id: "dashboard",
            title: ctx.t("open"),
            description: ctx.t("description"),
            keywords: "runmark usage cost tokens dashboard 费用 用量",
            group: "Runmark",
            enabled: !ctx.layout.narrow(),
            run: open,
        }));
    },
});
//# sourceMappingURL=gui.js.map