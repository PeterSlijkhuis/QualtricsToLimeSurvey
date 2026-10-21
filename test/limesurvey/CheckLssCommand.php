<?php
// Console command for CI: imports each .lss and runs LimeSurvey's survey logic check.
// Usage (from LimeSurvey's application folder): php commands/console.php checklss a.lss b.lss
Yii::import('application.helpers.replacements_helper', true);
Yii::import('application.helpers.expressions.em_manager_helper', true);
Yii::import('application.helpers.common_helper', true);
Yii::import('application.helpers.admin.import_helper', true);
class CheckLssCommand extends CConsoleCommand
{
    public function run($args)
    {
        Yii::app()->session['loginID'] = 1;
        Yii::app()->session['adminlang'] = 'en';
        // The logic report renders alert widgets, which a console app cannot do; only its error counts are used.
        Yii::app()->attachBehavior('noWidgets', new class extends CBehavior {
            public function widget() { return ''; }
        });
        // Theme loading raises harmless warnings outside a web request.
        set_error_handler(function () { return true; }, E_WARNING | E_NOTICE);
        $failed = 0;
        foreach ($args as $file) {
            $r = importSurveyFile($file, false, null, null);
            $why = [];
            if (!empty($r['error'])) $why[] = 'import error: ' . $r['error'];
            foreach ($r['importwarnings'] ?? [] as $w) $why[] = 'import warning: ' . strip_tags($w);
            if (!empty($r['newsid'])) {
                $sid = $r['newsid'];
                $lang = Survey::model()->findByPk($sid)->language;
                SetSurveyLanguage($sid, $lang);
                killSurveySession($sid);
                $logic = LimeExpressionManager::ShowSurveyLogicFile($sid);
                $errors = is_array($logic['errors']) ? array_sum($logic['errors']) : $logic['errors'];
                if ($errors) $why[] = "$errors ExpressionScript syntax error(s)";
            }
            echo basename($file), ': ', $why ? "FAIL\n  " . implode("\n  ", $why) : 'ok (survey ' . $r['newsid'] . ')', "\n";
            if ($why) $failed++;
        }
        if ($failed) exit(1);
    }
}
