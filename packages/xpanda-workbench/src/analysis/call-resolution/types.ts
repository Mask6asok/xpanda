/** Plain data only: these units cross browser worker boundaries. */
export interface CallInstruction {
    readonly pc: number;
    readonly opcode: string;
    readonly op: "copy" | "constant" | "function" | "class" | "object" | "property" | "construct" | "call" | "import" | "write" | "opaque" | "unknown" | "keep";
    readonly dest?: string;
    readonly src?: string;
    readonly methodId?: number;
    readonly classId?: string;
    readonly property?: string;
    readonly receiver?: string;
    readonly provenance?: string;
}
export interface CallClass {
    readonly id: string;
    readonly constructorId: number;
    readonly instanceMethods: Readonly<Record<string, number>>;
    readonly staticMethods: Readonly<Record<string, number>>;
    readonly fieldClasses?: Readonly<Record<string, readonly string[]>>;
}
export interface CallBlock {
    readonly id: number;
    readonly successors: readonly number[];
    readonly instructions: readonly CallInstruction[];
}
export interface CallCandidate {
    readonly siteId: string;
    readonly pc: number;
}
export interface CallAnalysisUnit {
    readonly sourceMethodOffset: number;
    readonly selectedMethodOffsets: readonly number[];
    readonly sites: readonly CallCandidate[];
    readonly blocks: readonly CallBlock[];
    readonly classes: readonly CallClass[];
    readonly thisClasses?: readonly string[];
    readonly issues: readonly string[];
    readonly maxSteps: number;
}
export interface CallAnalysisPlan {
    readonly units: readonly CallAnalysisUnit[];
    readonly assumptions: readonly string[];
    readonly preparationIssues: readonly string[];
}
export interface CallSiteOutcome {
    readonly siteId: string;
    readonly sourceMethodOffset: number;
    readonly pc: number;
    readonly relation: "resolved" | "possible" | "unresolved" | "excluded";
    readonly possibleMethodIds: readonly number[];
    readonly receiverOrigin: readonly string[];
    readonly reasons: readonly string[];
    readonly evidence: readonly string[];
    readonly hasUnknown: boolean;
}
