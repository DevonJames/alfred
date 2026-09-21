import QRCode from "qrcode";

export function botQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, {
    type: "svg",
    margin: 1,
    color: { dark: "#ffb347", light: "#050505" },
  });
}
