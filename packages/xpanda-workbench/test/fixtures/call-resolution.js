// Compile: es2abc --module --target-api-version 12 --record-name call-resolution
//   --output call-resolution.abc call-resolution.js
// Local declarations keep the target identity in each caller's own bytecode.
export function homonyms() {
    class First { hit() { return 1; } }
    class Second { hit() { return 2; } }
    const first = new First();
    first.hit();
    const second = new Second();
    second.hit();
}

export function aliases() {
    class AliasTarget { hit() { return 1; } }
    const first = new AliasTarget();
    const alias = first;
    const fn = alias.hit;
    fn();
}

export function overwrite(replacement) {
    class Overwritten { hit() { return 1; } }
    const receiver = new Overwritten();
    receiver.hit = replacement;
    receiver.hit();
}

export function override() {
    class Parent { hit() { return 1; } }
    class Child extends Parent { hit() { return 2; } }
    const receiver = new Child();
    receiver.hit();
}

export function mixedBranch(flag, unknownReceiver) {
    class BranchTarget { hit() { return 1; } }
    const receiver = flag ? new BranchTarget() : unknownReceiver;
    receiver.hit();
}

export function parameter(receiver) { receiver.hit(); }

export function returned(factory) {
    const receiver = factory();
    receiver.hit();
}

export function captured(receiver) {
    return () => receiver.hit();
}

export function sideEffect(mutate) {
    class Mutable { hit() { return 1; } }
    const receiver = new Mutable();
    mutate(receiver);
    receiver.hit();
}

export function exception(replacement) {
    class Protected { hit() { return 1; } }
    const receiver = new Protected();
    try { receiver.hit = replacement; }
    catch (error) { receiver.hit(); }
}
