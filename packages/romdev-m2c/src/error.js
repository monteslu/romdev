// Port of m2c/error.py
import { repr } from "./py.js";

export class DecompFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "DecompFailure";
    this.message = message;
  }
  __str__() {
    return this.message;
  }
}

export function assert_never(x) {
  throw new Error(`Unreachable: ${repr(x)}`);
}
