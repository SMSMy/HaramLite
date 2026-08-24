!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing Microsoft Visual C++ Redistributable..."
  ExecWait '"$INSTDIR\vc_redist.x64.exe" /install /quiet /norestart' $0
  DetailPrint "vc_redist exit code: $0"
  
  ${If} $0 != 0
  ${AndIf} $0 != 3010
  ${AndIf} $0 != 1638
    DetailPrint "تحذير: فشل تثبيت VC++ Redistributable (كود $0)"
  ${EndIf}
!macroend
