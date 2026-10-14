import type { JjPrMutationSnapshot } from "./jj-pr-mutation-form-model";
import { create } from "zustand";
import type { Forge } from "@/git/forge";
import type { JjChangeFormSnapshot } from "./jj-change-form-model";
import type { JjPrCreateSnapshot } from "./jj-pr-create-form-model";

type CheckoutActionForm =
  | { kind: "change"; snapshot: JjChangeFormSnapshot }
  | { kind: "create-pr"; snapshot: JjPrCreateSnapshot; forge: Forge }
  | { kind: "mutate-pr"; snapshot: JjPrMutationSnapshot; forge: Forge };

// Action surfaces may unmount at a breakpoint. The root host owns the opened form.
export const useCheckoutActionFormStore = create<{ form: CheckoutActionForm | null }>(() => ({
  form: null,
}));
export function openCheckoutActionForm(form: CheckoutActionForm): void {
  if (useCheckoutActionFormStore.getState().form === null)
    useCheckoutActionFormStore.setState({ form });
}
export function closeCheckoutActionForm(): void {
  useCheckoutActionFormStore.setState({ form: null });
}
