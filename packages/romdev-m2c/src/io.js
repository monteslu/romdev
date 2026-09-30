// io.js - stdout/stderr capture standing in for Python's print() / sys.stdout.
// m2c writes its output with print(); run() captures it into a string.

const stack = [];

/** Run fn with print() output captured; returns { value, stdout, stderr }. */
export function capture(fn) {
  const sink = { out: [], err: [] };
  stack.push(sink);
  let value;
  try {
    value = fn();
  } finally {
    stack.pop();
  }
  return { value, stdout: sink.out.join(""), stderr: sink.err.join("") };
}

function current() {
  return stack[stack.length - 1] ?? null;
}

/** Python print(*args, sep=" ", end="\n", file=stdout|stderr). */
export function print(...args) {
  let opts = {};
  if (args.length && args[args.length - 1] && typeof args[args.length - 1] === "object" && args[args.length - 1].__print_opts) opts = args.pop();
  const { sep = " ", end = "\n", stderr = false } = opts;
  const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(sep) + end;
  write(text, stderr);
}

/** Options marker for print(): print("x", popts({ end: "" })). */
export function popts(o) {
  return { ...o, __print_opts: true };
}

/** sys.stdout.write / sys.stderr.write */
export function write(text, stderr = false) {
  const s = current();
  if (s) (stderr ? s.err : s.out).push(text);
  else (stderr ? process.stderr : process.stdout).write(text);
}
