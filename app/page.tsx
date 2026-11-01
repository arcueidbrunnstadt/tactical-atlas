import { headers } from "next/headers";
import Atlas from "./atlas";
import { localeMetadata } from "../lib/locale-routing";

async function requestLocale() { return (await headers()).get("x-atlas-locale") === "zh" ? "zh" : "en"; }
export async function generateMetadata() { return localeMetadata(await requestLocale()); }
export default async function Home() { return <Atlas initialLocale={await requestLocale()} />; }
