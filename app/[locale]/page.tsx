import { notFound } from "next/navigation";
import Atlas from "../atlas";
import { localeMetadata } from "../../lib/locale-routing";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  if (locale !== "en" && locale !== "zh") return {};
  return localeMetadata(locale);
}

export default async function LocalizedPage({ params }: Props) {
  const { locale } = await params;
  if (locale !== "en" && locale !== "zh") notFound();
  return <Atlas initialLocale={locale} />;
}
