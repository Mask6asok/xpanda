// es2abc --merge-abc --module --target-api-version 12 --record-name call-owner --output call-owner.abc call-owner.js
export class Owner {
    target() { return 1; }
    caller() { return this.target(); }
}
export class Other {
    target() { return 2; }
}
