import { monotonicFactory } from "ulid";

const nextUlid = monotonicFactory();

/** A new ULID (time-ordered, monotonic within the process). All primary keys use this. */
export function newId(): string {
  return nextUlid();
}
