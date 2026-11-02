const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const unpacked = path.join(root, 'build', 'win-unpacked', 'resources');
const outDir = path.join(root, 'build', `patch-${version}`);
const zipPath = path.join(root, 'build', `Decominicon-Patch-${version}.zip`);

if (!fs.existsSync(path.join(unpacked, 'app.asar'))) {
  console.error('Manque build/win-unpacked/resources/app.asar — lance npm run dist d’abord.');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(unpacked, 'app.asar'), path.join(outDir, 'app.asar'));

const unpackedSrc = path.join(unpacked, 'app.asar.unpacked');
if (fs.existsSync(unpackedSrc)) {
  fs.cpSync(unpackedSrc, path.join(outDir, 'app.asar.unpacked'), { recursive: true });
}

fs.writeFileSync(
  path.join(outDir, 'LISEZMOI.txt'),
  [
    `DécoMiniCon patch ${version}`,
    '',
    'Ce patch met à jour ton app SANS nouvel installeur.',
    'Ton DécoMiniCon.exe déjà autorisé par Windows / antivirus reste le même.',
    '',
    '1. Ferme DécoMiniCon (barre + panneau).',
    '2. Double-clique APPLIQUER.bat',
    '3. Relance DécoMiniCon comme d’habitude (ANGE).',
    '',
    'Si APPLIQUER.bat ne trouve pas l’app :',
    '- Ouvre le dossier où est installé DécoMiniCon',
    '- Va dans le sous-dossier resources',
    '- Remplace app.asar (et app.asar.unpacked) par ceux de ce zip',
    ''
  ].join('\r\n'),
  'utf8'
);

fs.writeFileSync(
  path.join(outDir, 'APPLIQUER.bat'),
  [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal EnableExtensions',
    'cd /d "%~dp0"',
    'echo.',
    `echo === Patch DécoMiniCon ${version} ===`,
    'echo.',
    'echo Fermeture de DécoMiniCon si ouvert...',
    'taskkill /F /IM "DécoMiniCon.exe" >nul 2>&1',
    'timeout /t 1 /nobreak >nul',
    '',
    'set "TARGET="',
    'if exist "%LOCALAPPDATA%\\Programs\\DécoMiniCon\\resources\\app.asar" set "TARGET=%LOCALAPPDATA%\\Programs\\DécoMiniCon"',
    'if not defined TARGET if exist "%LOCALAPPDATA%\\Programs\\decominicon\\resources\\app.asar" set "TARGET=%LOCALAPPDATA%\\Programs\\decominicon"',
    '',
    'if not defined TARGET (',
    '  echo Installation introuvable automatiquement.',
    '  echo Copie manuellement app.asar dans le dossier resources de ton install.',
    '  echo Puis relance DécoMiniCon.exe',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'echo Cible: %TARGET%',
    'copy /Y "app.asar" "%TARGET%\\resources\\app.asar" >nul',
    'if errorlevel 1 (',
    '  echo Echec copie app.asar — ferme bien l’app et réessaie.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'if exist "app.asar.unpacked" (',
    '  echo Copie modules natifs...',
    '  xcopy /E /I /Y "app.asar.unpacked" "%TARGET%\\resources\\app.asar.unpacked" >nul',
    ')',
    '',
    'echo.',
    'echo OK — patch appliqué.',
    'echo Relance DécoMiniCon...',
    'start "" "%TARGET%\\DécoMiniCon.exe"',
    'echo.',
    'pause'
  ].join('\r\n'),
  'utf8'
);

if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
const ps = [
  `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zipPath}' -Force`
].join(' ');
execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
console.log(`OK ${zipPath}`);
