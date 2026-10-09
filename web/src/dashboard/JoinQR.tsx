import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { loadConfig } from "../shared/awsIot";

/** "Join the fleet" button + full-screen QR code that phones can scan. */
export function JoinQR() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [svg, setSvg] = useState("");

  useEffect(() => {
    loadConfig()
      .then((c) => c.deviceUrl ?? `${location.origin}/device.html`)
      .catch(() => `${location.origin}/device.html`)
      .then((u) => {
        setUrl(u);
        return QRCode.toString(u, { type: "svg", margin: 1, color: { dark: "#060a14", light: "#ffffff" } });
      })
      .then(setSvg)
      .catch(() => {});
  }, []);

  return (
    <>
      <button className="join-btn" onClick={() => setOpen(true)} title="Show a QR code phones can scan">
        <span>📲</span> Join
      </button>
      {open && (
        <div className="qr-overlay" onClick={() => setOpen(false)}>
          <div className="qr-card" onClick={(e) => e.stopPropagation()}>
            <h2>Scan to turn your phone into an IoT device</h2>
            <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
            <p className="mono">{url.replace(/^https?:\/\//, "")}</p>
            <small>Pick a free slot (PHONE 01-04), type your name, tap Connect.</small>
            <button className="etl-btn" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
