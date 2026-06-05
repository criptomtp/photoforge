import QAClient from "./qa-client";

export const revalidate = 0;

export default async function BatchQAPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  return <QAClient batchId={batchId} />;
}
