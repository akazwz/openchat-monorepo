// noVNC 1.7 exports its client from the package root and ships no types; the
// community types describe the same RFB class under its former path.
declare module "@novnc/novnc" {
	import RFB from "@novnc/novnc/lib/rfb";
	export default RFB;
}
