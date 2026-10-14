import { JjChangeForm } from "./jj-change-controls";
import { JjPrCreateFormHost } from "./jj-pr-create-form";
import { closeCheckoutActionForm, useCheckoutActionFormStore } from "./action-forms-store";

export function CheckoutActionFormsHost() {
  const form = useCheckoutActionFormStore((state) => state.form);
  if (!form) return null;
  const { snapshot } = form;
  const key = `${snapshot.serverId}:${snapshot.cwd}:${snapshot.changeId}`;
  if (form.kind === "change")
    return <JjChangeForm key={key} snapshot={form.snapshot} onClose={closeCheckoutActionForm} />;
  return (
    <JjPrCreateFormHost
      key={key}
      snapshot={form.snapshot}
      forge={form.forge}
      onClose={closeCheckoutActionForm}
    />
  );
}
