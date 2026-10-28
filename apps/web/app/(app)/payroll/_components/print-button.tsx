"use client";

import { Button } from "@/components/ui/button";

/** 印刷: the browser's print dialog (the page's `@media print` keeps only the payslip). */
export function PrintButton() {
  return (
    <Button size="sm" onClick={() => window.print()}>
      印刷
    </Button>
  );
}
