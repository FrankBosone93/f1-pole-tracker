#!/bin/bash
# scripts/lib/push-with-retry.sh
#
# Wrapper attorno a "git push" con retry automatico. Più workflow schedulati
# di questo repository girano in finestre orarie vicine (i cron di GitHub
# Actions possono ritardare parecchio nei periodi di carico, facendo
# scattare workflow diversi quasi in contemporanea): se due di loro fanno
# commit+push nello stesso momento, il primo vince e i successivi vengono
# respinti dal branch protection di git ("fetch first" / "cannot lock
# ref") anche se toccano file completamente diversi - è un conflitto sul
# branch, non sul contenuto (osservato realmente più volte in produzione).
#
# Ad ogni tentativo fallito: si riallinea con origin/main (fetch + rebase,
# che va a buon fine senza conflitti reali quando i workflow toccano file
# diversi) e ripete il push, con una breve pausa casuale per non
# risincronizzarsi di nuovo con l'altro workflow allo stesso istante.
#
# Uso, dentro uno step "run:" (dopo aver già fatto git add + git commit):
#   source scripts/lib/push-with-retry.sh
#   push_with_retry

push_with_retry() {
    for attempt in 1 2 3 4 5; do
        if git push; then
            return 0
        fi
        if [ "$attempt" -eq 5 ]; then
            echo "❌ Push fallito dopo 5 tentativi."
            return 1
        fi
        echo "⏳ Push rifiutato (tentativo $attempt/5): probabilmente un altro workflow ha pushato nel frattempo. Mi riallineo e riprovo..."
        git fetch origin main
        if ! git rebase origin/main; then
            echo "❌ Rebase fallito: conflitto reale, impossibile riallinearsi in automatico."
            git rebase --abort
            return 1
        fi
        sleep $((RANDOM % 8 + 2))
    done
}
