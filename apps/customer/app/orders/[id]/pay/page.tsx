import { redirect } from "next/navigation";

type Props = { params: Promise<{ id: string }> };

/** Payment (finding a rider, funding) now lives inline on the main order
 * page alongside its step timeline instead of as a separate screen — this
 * stays only so any old link/bookmark to it still lands somewhere valid. */
export default async function PayStagePage({ params }: Props) {
  const { id } = await params;
  redirect(`/orders/${id}`);
}
