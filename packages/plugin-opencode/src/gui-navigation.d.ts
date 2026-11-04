/** Bounded document-local history; never uses the parent application's joint history. */
export declare function createFrameNavigation(base: URL): {
    current: () => string;
    back: () => string | undefined;
    forward: () => string | undefined;
    canBack: () => boolean;
    canForward: () => boolean;
    visit(href: unknown, replace?: boolean): boolean;
    display(): string;
};
//# sourceMappingURL=gui-navigation.d.ts.map