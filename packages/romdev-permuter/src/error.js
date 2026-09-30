// error.js - decomp-permuter's src/error.py.

export class ServerError extends Error {
  constructor(message) { super(message); this.name = "ServerError"; }
}

/** The base source cannot be turned into a candidate (syntax error, missing function, no compile). */
export class CandidateConstructionFailure extends Error {
  constructor(message) { super(message); this.name = "CandidateConstructionFailure"; }
}
