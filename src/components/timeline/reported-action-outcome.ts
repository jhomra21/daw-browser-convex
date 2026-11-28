export type ReportedActionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false }

/** For actions whose owner has already reported a failure to the user before rejecting. */
export const settleReportedAction = <T>(action: Promise<T>): Promise<ReportedActionOutcome<T>> => (
  action.then(
    (value): ReportedActionOutcome<T> => ({ ok: true, value }),
    (): ReportedActionOutcome<T> => ({ ok: false }),
  )
);
