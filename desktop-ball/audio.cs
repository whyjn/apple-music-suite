/* ============================================================================
 * AmAudio - per-session audio peak metering for the Apple Music desktop ball
 * ----------------------------------------------------------------------------
 * Reads IAudioMeterInformation on individual audio *sessions* (not the whole
 * output device), so only the chosen apps drive the breathing light.
 *
 * Why a cache: enumerating sessions and resolving process names costs ~0.1ms
 * per session. We only need to do that when the session list changes, so the
 * expensive part is refreshed at most once every 3 seconds. The per-tick cost
 * is then just GetPeakValue(), which is a few microseconds.
 *
 * No external dependencies - pure COM interop against the Windows audio stack.
 * ========================================================================== */

using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
    int RegisterEndpointNotificationCallback(IntPtr pClient);
    int UnregisterEndpointNotificationCallback(IntPtr pClient);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice
{
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
}

[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMeterInformation
{
    int GetPeakValue(out float pfPeak);
    int GetMeteringChannelCount(out int pnChannelCount);
    int GetChannelsPeakValues(int u32ChannelCount, [Out] float[] afPeakValues);
    int QueryHardwareSupport(out int pdwHardwareSupportMask);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2
{
    // --- IAudioSessionManager ---
    int GetAudioSessionControl(ref Guid AudioSessionGuid, int StreamFlags, out IntPtr SessionControl);
    int GetSimpleAudioVolume(ref Guid AudioSessionGuid, int StreamFlags, out IntPtr AudioVolume);
    // --- IAudioSessionManager2 ---
    int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
    int RegisterSessionNotification(IntPtr SessionNotification);
    int UnregisterSessionNotification(IntPtr SessionNotification);
    int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionID, IntPtr duckNotification);
    int UnregisterDuckNotification(IntPtr duckNotification);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator
{
    int GetCount(out int SessionCount);
    int GetSession(int SessionCount, out IAudioSessionControl2 Session);
}

/* vtable order must match IAudioSessionControl followed by IAudioSessionControl2 */
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2
{
    // --- IAudioSessionControl (9 methods) ---
    int GetState(out int pRetVal);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetGroupingParam(out Guid pRetVal);
    int SetGroupingParam(ref Guid Override, ref Guid EventContext);
    int RegisterAudioSessionNotification(IntPtr NewNotifications);
    int UnregisterAudioSessionNotification(IntPtr NewNotifications);
    // --- IAudioSessionControl2 (5 methods) ---
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int GetProcessId(out int pRetVal);
    int IsSystemSoundsSession();
    int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}

public static class AmAudio
{
    private const int eRender = 0;
    private const int eConsole = 0;
    private const int CLSCTX_ALL = 23;
    private const double CACHE_SECONDS = 3.0;

    private static IAudioMeterInformation[] _cache;
    private static string _cacheKey;
    private static DateTime _cacheAt = DateTime.MinValue;

    private static IAudioSessionEnumerator OpenSessions()
    {
        try
        {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
            IMMDevice dev;
            if (enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out dev) != 0 || dev == null)
                return null;

            Guid iid = typeof(IAudioSessionManager2).GUID;
            object obj;
            if (dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out obj) != 0 || obj == null)
                return null;

            IAudioSessionEnumerator se;
            if (((IAudioSessionManager2)obj).GetSessionEnumerator(out se) != 0)
                return null;
            return se;
        }
        catch { return null; }
    }

    private static IAudioMeterInformation[] Collect(string[] names)
    {
        var list = new System.Collections.Generic.List<IAudioMeterInformation>();
        try
        {
            var se = OpenSessions();
            if (se == null) return list.ToArray();

            int count = 0;
            if (se.GetCount(out count) != 0) return list.ToArray();

            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl2 ctl;
                if (se.GetSession(i, out ctl) != 0 || ctl == null) continue;

                int pid = 0;
                if (ctl.GetProcessId(out pid) != 0) continue;

                string pname = "";
                try { pname = System.Diagnostics.Process.GetProcessById(pid).ProcessName; }
                catch { continue; }

                bool match = false;
                for (int k = 0; k < names.Length; k++)
                {
                    if (string.Equals(pname, names[k], StringComparison.OrdinalIgnoreCase))
                    { match = true; break; }
                }
                if (!match) continue;

                var meter = ctl as IAudioMeterInformation;
                if (meter != null) list.Add(meter);
            }
        }
        catch { }
        return list.ToArray();
    }

    private static IAudioMeterInformation[] GetMeters(string[] names)
    {
        string key = string.Join(",", names);
        if (_cache != null && _cacheKey == key &&
            (DateTime.UtcNow - _cacheAt).TotalSeconds < CACHE_SECONDS)
            return _cache;

        _cache = Collect(names);
        _cacheKey = key;
        _cacheAt = DateTime.UtcNow;
        return _cache;
    }

    /// <summary>Largest live peak (0..1) among the given process names.</summary>
    public static float GetPeakForProcesses(string[] names)
    {
        if (names == null || names.Length == 0) return 0f;
        float best = 0f;
        try
        {
            var meters = GetMeters(names);
            for (int i = 0; i < meters.Length; i++)
            {
                float p;
                if (meters[i].GetPeakValue(out p) == 0 && p > best) best = p;
            }
        }
        catch { }
        return best;
    }

    /// <summary>Number of cached matching sessions (for diagnostics).</summary>
    public static int GetMatchedSessionCount(string[] names)
    {
        try { return GetMeters(names).Length; }
        catch { return -1; }
    }

    /// <summary>Diagnostic dump of every audio session.</summary>
    public static string DumpSessions()
    {
        var sb = new System.Text.StringBuilder();
        try
        {
            var se = OpenSessions();
            if (se == null) { sb.Append("(no session enumerator)"); return sb.ToString(); }

            int count = 0;
            se.GetCount(out count);
            sb.Append("sessions=").Append(count);

            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl2 ctl;
                if (se.GetSession(i, out ctl) != 0 || ctl == null) continue;

                int pid = 0; ctl.GetProcessId(out pid);
                string pname = "?";
                try { pname = System.Diagnostics.Process.GetProcessById(pid).ProcessName; }
                catch { }

                string disp = "";
                try { ctl.GetDisplayName(out disp); } catch { }
                if (disp == null) disp = "";

                float p = 0f;
                var meter = ctl as IAudioMeterInformation;
                if (meter != null) meter.GetPeakValue(out p);

                sb.Append("\n   [").Append(i).Append("] ")
                  .Append(pname).Append("(pid=").Append(pid).Append(")")
                  .Append(" peak=").Append(p.ToString("0.000"))
                  .Append(" name=\"").Append(disp).Append("\"");
            }
        }
        catch (Exception e) { sb.Append("error: ").Append(e.Message); }
        return sb.ToString();
    }
}
