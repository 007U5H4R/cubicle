import BareRun from "@/components/office/BareRun";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BareRun id={id} />;
}
