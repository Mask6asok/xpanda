/**
 * @Author: jmp0
 */
export class PandaParseException extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PandaParseException";
    }
}

export class PandaChecksumException extends PandaParseException {
    constructor(readonly expected: number, readonly calculated: number) {
        super(`ABC checksum mismatch: header=${expected} calculated=${calculated}`);
        this.name = "PandaChecksumException";
    }
}

export class PandaDecompileException extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PandaDecompileException";
    }
}
