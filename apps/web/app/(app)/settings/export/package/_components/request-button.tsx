"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/**
 * 「作成を依頼」 of the package form: off, and 「依頼中…」, while the Server Action runs, so that a
 * second click cannot make a second request (05-ui-ux §3.1 フォーム). Without JS it is a plain
 * submit button.
 */
export function RequestButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" disabled={pending}>
      {pending ? "依頼中…" : "作成を依頼"}
    </Button>
  );
}
