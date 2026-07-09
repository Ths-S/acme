#!/bin/bash
# Navega até a pasta do projeto
cd "/home/ths/Área de trabalho/Agy2 v1"

# Abre o navegador após 1 segundo (tempo para o servidor subir)
(sleep 1 && xdg-open http://localhost:3001) &

# Inicia o servidor Node
node server.js
