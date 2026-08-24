!macro NSIS_HOOK_PREINSTALL
  ; Check if Visual C++ 2015-2022 Redistributable is installed
  ReadRegDWord $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  
  ${If} $0 != 1
    DetailPrint "Extracting Microsoft Visual C++ Redistributable..."
    SetOutPath $PLUGINSDIR
    File "..\..\..\..\vc_redist.x64.exe"
    
    DetailPrint "Installing Microsoft Visual C++ Redistributable..."
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /passive /norestart'
  ${EndIf}
!macroend
