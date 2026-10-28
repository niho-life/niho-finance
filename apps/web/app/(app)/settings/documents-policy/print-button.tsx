"use client";

import { Button } from "@/components/ui/button";

/** 「印刷」: the browser's print of the policy text only (`[data-print-root]`, globals.css). */
export function PrintButton() {
  return (
    <Button size="sm" onClick={() => window.print()}>
      印刷
    </Button>
  );
}
