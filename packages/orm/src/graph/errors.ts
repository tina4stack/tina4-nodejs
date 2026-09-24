/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Graph layer errors — the graph siblings of the relational fail-loud contract.
 *
 * A bad graph statement RAISES (never a falsy return); the cause is readable via
 * the adapter's getError() after the throw. An unreachable host throws
 * GraphConnectTimeout within TINA4_GRAPH_CONNECT_TIMEOUT, naming host and port.
 */

/** A graph operation failed (bad statement, engine error). */
export class GraphError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GraphError";
  }
}

/**
 * A graph connect exceeded TINA4_GRAPH_CONNECT_TIMEOUT.
 *
 * The message names the host, the port and the elapsed seconds — the mirror of
 * the relational DatabaseConnectTimeout, so an operator can tell "my bound
 * fired" apart from "the engine rejected me".
 */
export class GraphConnectTimeout extends GraphError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "GraphConnectTimeout";
  }
}
