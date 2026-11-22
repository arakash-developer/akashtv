# AKASH TV audio helper: lists output devices, switches the default one, reads/sets volume + mute.
# Runs as a long-lived process: one command per line on stdin, one JSON line on stdout.
#   list | set <deviceId> | vol | setvol <0..100> | mute <0|1>
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding  = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace AkashAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo {}
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigCo {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  }
  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IPropertyStore properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }
  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int prop, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
  }
  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT {
    [FieldOffset(0)] public short vt;
    [FieldOffset(8)] public IntPtr p;
    [FieldOffset(16)] public IntPtr pad;
  }
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out int count);
    int SetMasterVolumeLevel(float levelDB, ref Guid ctx);
    int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    int GetMasterVolumeLevel(out float levelDB);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint ch, float levelDB, ref Guid ctx);
    int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
    int GetChannelVolumeLevel(uint ch, out float levelDB);
    int GetChannelVolumeLevelScalar(uint ch, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    int GetMixFormat(IntPtr a, IntPtr b);
    int GetDeviceFormat(IntPtr a, int b, IntPtr c);
    int ResetDeviceFormat(IntPtr a);
    int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
    int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
    int SetProcessingPeriod(IntPtr a, IntPtr b);
    int GetShareMode(IntPtr a, IntPtr b);
    int SetShareMode(IntPtr a, IntPtr b);
    int GetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
    int SetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
    int SetEndpointVisibility(IntPtr a, int b);
  }

  public class Device { public string id; public string name; public bool isDefault; }

  public static class Audio {
    const int eRender = 0, eMultimedia = 1, DEVICE_STATE_ACTIVE = 1;
    static IMMDeviceEnumerator En() { return (IMMDeviceEnumerator)new MMDeviceEnumeratorCo(); }

    static string Name(IMMDevice d) {
      IPropertyStore ps; d.OpenPropertyStore(0, out ps);
      var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      PROPVARIANT v; ps.GetValue(ref key, out v);
      return v.vt == 31 ? Marshal.PtrToStringUni(v.p) : "Unknown device";
    }
    static string DefaultId() {
      IMMDevice d;
      if (En().GetDefaultAudioEndpoint(eRender, eMultimedia, out d) != 0 || d == null) return null;
      string id; d.GetId(out id); return id;
    }
    public static List<Device> List() {
      var list = new List<Device>();
      IMMDeviceCollection col; En().EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col);
      int n; col.GetCount(out n);
      string def = DefaultId();
      for (int i = 0; i < n; i++) {
        IMMDevice d; col.Item(i, out d);
        string id; d.GetId(out id);
        list.Add(new Device { id = id, name = Name(d), isDefault = id == def });
      }
      return list;
    }
    public static void SetDefault(string id) {
      var pc = (IPolicyConfig)new PolicyConfigCo();
      for (int role = 0; role < 3; role++) pc.SetDefaultEndpoint(id, role); // console, multimedia, communications
    }
    static IAudioEndpointVolume Vol() {
      IMMDevice d; En().GetDefaultAudioEndpoint(eRender, eMultimedia, out d);
      var iid = typeof(IAudioEndpointVolume).GUID; object o;
      d.Activate(ref iid, 23, IntPtr.Zero, out o);
      return (IAudioEndpointVolume)o;
    }
    public static float GetVolume() { float v; Vol().GetMasterVolumeLevelScalar(out v); return v; }
    public static bool GetMute() { bool m; Vol().GetMute(out m); return m; }
    public static void SetVolume(float v) { var g = Guid.Empty; Vol().SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, v)), ref g); }
    public static void SetMute(bool m) { var g = Guid.Empty; Vol().SetMute(m, ref g); }
  }
}
'@

function State {
  $devs = @([AkashAudio.Audio]::List() | ForEach-Object { @{ id = $_.id; name = $_.name; isDefault = $_.isDefault } })
  $vol = 0; $mute = $false
  try { $vol = [math]::Round([AkashAudio.Audio]::GetVolume() * 100); $mute = [AkashAudio.Audio]::GetMute() } catch {}
  return @{ ok = $true; devices = $devs; volume = $vol; mute = $mute }
}

[Console]::Out.WriteLine((@{ ok = $true; ready = $true } | ConvertTo-Json -Compress))
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $cmd, $arg = $line.Trim() -split ' ', 2
  try {
    switch ($cmd) {
      'set'    { [AkashAudio.Audio]::SetDefault($arg) }
      'setvol' { [AkashAudio.Audio]::SetVolume([float]$arg / 100) }
      'mute'   { [AkashAudio.Audio]::SetMute($arg -eq '1') }
    }
    $out = State
  } catch {
    $out = @{ ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
}
