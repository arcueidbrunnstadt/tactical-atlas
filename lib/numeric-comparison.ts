export const NUMERIC_COMPARISONS = ["gte", "near", "lte"] as const;
export type NumericComparisonOperator = typeof NUMERIC_COMPARISONS[number];

export const NUMERIC_COMPARISON_LABELS = { gte: "At least", near: "Around", lte: "At most" } as const;

export function isNumericComparisonOperator(operator: unknown): operator is NumericComparisonOperator {
  return NUMERIC_COMPARISONS.some((comparison) => comparison === operator);
}

/** Soft fit for a positive target and a positive estimate. An open upper end is not a point. */
export function numericPreferenceFit(
  operator: NumericComparisonOperator, target: number, lower: number, upper: number | null,
): { fit: number; comparedValue: number } | null {
  if (operator === "gte") return { fit: Math.min(lower / target, 1), comparedValue: lower };
  if (upper === null) return null;
  if (operator === "lte") return { fit: Math.min(target / upper, 1), comparedValue: upper };

  // The least favorable endpoint avoids assuming that the estimate's midpoint is typical.
  const comparedValue = Math.abs(lower - target) > Math.abs(upper - target) ? lower : upper;
  return { fit: Math.max(0, 1 - Math.abs(comparedValue - target) / target), comparedValue };
}
