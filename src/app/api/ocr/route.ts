import { NextResponse } from "next/server";
import { scanReceiptImage } from "@/lib/receipt-ocr";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData().catch(() => null);
  const file = formData?.get("receipt");

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      {
        error: "Upload a receipt image."
      },
      { status: 400 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const extraction = await scanReceiptImage(bytes);

  return NextResponse.json({
    fields: extraction.fields,
    fallback: extraction.fallback,
    rawText: extraction.rawText,
    source: extraction.source
  });
}
