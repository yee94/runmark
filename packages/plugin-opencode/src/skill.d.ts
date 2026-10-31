export type BundledSkill = {
    id: string;
    name: string;
    description: string;
    path: string;
    content: string;
};
export type SkillHost = {
    skill?: {
        transform(callback: (editor: {
            get(id: string): BundledSkill | undefined;
            add(skill: BundledSkill): void;
            update(id: string, update: (skill: BundledSkill) => void): void;
        }) => void): Promise<{
            dispose(): Promise<void>;
        }>;
    };
};
export declare const bundledSkillsDirectory: string;
export declare function setupRunmarkSkill(ctx: SkillHost): Promise<{
    dispose(): Promise<void>;
} | undefined>;
//# sourceMappingURL=skill.d.ts.map