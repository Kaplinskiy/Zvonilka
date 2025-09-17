<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Звонилка</title>
</head>
<body>
  <!-- page content -->

  <div id="logList"></div>

  <script type="module">
  // Безопасное подключение утилит (ничего не переопределяет и не ломает текущую логику)
  import '/src/utils/logger.js';
  import '/src/utils/url.js';
  import '/src/utils/env.js';
  </script>

  <script>
  (() => {
    // main application IIFE with WebRTC/signaling code
    // ...
  })();
  </script>
</body>
</html>