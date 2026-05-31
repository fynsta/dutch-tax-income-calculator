import { Component, OnInit, AfterViewChecked, OnDestroy } from '@angular/core';
import { trigger, transition, style, animate } from '@angular/animations';
import { AbstractControl, FormControl, ValidationErrors, Validators } from '@angular/forms';
import { ErrorStateMatcher } from '@angular/material/core';
import { ActivatedRoute, Router } from '@angular/router';
import { constants, SalaryPaycheck } from 'dutch-tax-income-calculator';
import { fromEvent, interval, merge, Subject } from 'rxjs';
import { debounceTime, filter, takeUntil } from 'rxjs/operators';
import { CookieService } from 'ngx-cookie-service';
import { SwUpdate } from '@angular/service-worker';

/** Shows the error state as soon as the control is invalid, without waiting for blur. */
class ImmediateErrorStateMatcher implements ErrorStateMatcher {
  isErrorState(control: AbstractControl | null): boolean {
    return !!control && control.invalid;
  }
}

// Paycheck fields that are a per-period slice of a yearly total. For a partial year
// these are rescaled from the full-year cadence to the worked cadence.
const PERIOD_FIELDS = [
  'grossMonth', 'grossWeek', 'grossDay', 'grossHour',
  'payrollTaxMonth', 'socialTaxMonth', 'taxWithoutCreditMonth',
  'generalCreditMonth', 'labourCreditMonth', 'taxCreditMonth',
  'incomeTaxMonth', 'netMonth', 'netWeek', 'netDay', 'netHour',
];

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styles: [`
    .output-results-table {
      width: 600px;
    }
    
    @media (max-width: 600px) {
      :host ::ng-deep .mdc-data-table__cell {
        padding: 0 10px;
      }
    }
    
    @media (max-width: 960px) {
      :host ::ng-deep table {
        table-layout: fixed;
      }
      :host ::ng-deep td.mat-mdc-cell {
        word-break: break-word;
        white-space: normal;
      }
      :host ::ng-deep td.mat-mdc-cell.report-value {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      }
      .support-message {
        display: none !important;
      }
      .output-results-table {
        width: 100% !important;
      }

      .results-container {
        flex-direction: column;
      }
    }
  `],
    animations: [
        trigger('fadeInOut', [
            transition(':enter', [
                style({ opacity: 0 }),
                animate('300ms ease-in', style({ opacity: 1 }))
            ])
        ])
    ],
    standalone: false
})
export class AppComponent implements OnInit, AfterViewChecked, OnDestroy {
  showDonateButton = false;
  totalCalculations = 0;
  private calculationSubject = new Subject<void>();
  private destroy$ = new Subject<void>();
  private meaningfulCalculations = 0;
  private readonly CALCULATION_DEBOUNCE_TIME = 2000; // 2 seconds
  private readonly CALCULATIONS_BEFORE_DONATE = 2;
  readonly MINUTES_PER_CALCULATION = 23; // estimated minutes saved per calculation
  title = 'dutch-tax-income-calculator';
  selectedYear = new FormControl(constants.currentYear.toString());
  years = constants.years.reverse().map((year: number) => year.toString());
  hoursAmount = new FormControl(constants.defaultWorkingHours);
  income = new FormControl(60000);
  startFrom = new FormControl<'Year' | 'Month' | 'Week' | 'Day' | 'Hour'> ('Year');
  ruling = new FormControl(false);
  rulingChoice = new FormControl('normal');
  allowance = new FormControl(false);
  holidayPayoutMay = new FormControl(false);
  older = new FormControl(false);
  partialYear = new FormControl(false);
  workedPeriod = new FormControl<'Weeks' | 'Months'>('Weeks');
  workedDuration = new FormControl(10, {
    validators: [Validators.required, Validators.min(1), this.maxDurationValidator()],
  });
  readonly workingWeeks = constants.workingWeeks;
  readonly errorMatcher = new ImmediateErrorStateMatcher();

  // Max worked duration: a full year of the selected period (52 weeks or 12 months).
  get maxDuration(): number {
    return this.workedPeriod.value === 'Months' ? 12 : this.workingWeeks;
  }

  private maxDurationValidator() {
    return (control: AbstractControl): ValidationErrors | null =>
      Number(control.value) > this.maxDuration ? { max: true } : null;
  }
  paycheck!: any;

  extraOptions = [
    {
      name: 'grossAllowance',
      sign: '',
      title: 'Year Gross Holiday Allowance',
      label: 'Gross Holiday Allowance per year',
      checked: false,
    },
    {
      name: 'grossYear',
      sign: '',
      title: 'Year Gross Income',
      label: 'Annual Gross Income',
      checked: false,
    },
    {
      name: 'grossMonth',
      sign: '',
      title: 'Month Gross Income',
      label: 'Monthly Gross Income',
      checked: false,
    },
    {
      name: 'grossWeek',
      sign: '',
      title: 'Week Gross Income',
      label: 'Gross Income per week',
      checked: false,
    },
    {
      name: 'grossDay',
      sign: '',
      title: 'Day Gross Income',
      label: 'Gross Income per day',
      checked: false,
    },
    {
      name: 'grossHour',
      sign: '',
      title: 'Hour Gross Income',
      label: 'Gross Income per hour',
      checked: false,
    },
    {
      name: 'taxFreeYear',
      sign: '-',
      title: 'Tax Free Income',
      label: 'Amount of income that goes tax free',
      checked: false,
    },
    {
      name: 'taxFree',
      sign: '',
      title: 'Ruling Real Percentage',
      label: 'Absolute Percentage calculated from ruling income and non ruling',
      checked: false,
    },
    {
      name: 'taxableYear',
      sign: '',
      title: 'Taxable Income',
      label: 'Taxable Income Amount',
      checked: true,
    },
    {
      name: 'payrollTax',
      sign: '',
      title: 'Payroll Tax',
      label:
        'Payroll tax is tax imposed on employers or employees, and is calculated as a percentage of the salary that employer pay their staff',
      checked: true,
    },
    {
      name: 'socialTax',
      sign: '',
      title: 'Social Security Tax',
      label:
        'Social Security tax is the tax levied on both employers and employees to fund the Social Security program',
      checked: true,
    },
    {
      name: 'generalCredit',
      sign: '+',
      title: 'General Tax Credit',
      label:
        'General tax credit (algemene heffingskorting) that everyone is entitled',
      checked: true,
    },
    {
      name: 'labourCredit',
      sign: '+',
      title: 'Labour Tax Credit',
      label:
        'Labour tax credit (arbeidskorting) that is given to those that are still in the labour force',
      checked: true,
    },
    {
      name: 'incomeTax',
      sign: '-',
      title: 'Total Income Tax',
      label: 'Total Amount of Taxes',
      checked: false,
    },
    {
      name: 'incomeTaxMonth',
      sign: '-',
      title: 'Month Total Income Tax',
      label: 'Total Amount of Taxes per Month',
      checked: false,
    },
    {
      name: 'netAllowance',
      sign: '',
      title: 'Year Net Holiday Allowance',
      label: 'Year Net Holiday Allowance',
      checked: false,
    },
    {
      name: 'netYear',
      sign: '',
      title: 'Year Net Income',
      label: 'Annual Net Income',
      checked: true,
    },
    {
      name: 'netMonth',
      sign: '',
      title: 'Month Net Income',
      label: 'Monthly Net Income',
      checked: true,
    },
    {
      name: 'netWeek',
      sign: '',
      title: 'Week Net Income',
      label: 'Weekly Net Income',
      checked: false,
    },
    {
      name: 'netDay',
      sign: '',
      title: 'Day Net Income',
      label: 'Daily Net Income',
      checked: false,
    },
    {
      name: 'netHour',
      sign: '',
      title: 'Hour Net Income',
      label: 'Hourly Net Income',
      checked: false,
    },
  ];

  dataSource!: { name: string; value: number }[];
  displayedColumns: string[] = ['name', 'value'];
  
  tooltipCell: string | null = null;
  tooltipPosition: { x: number; y: number } | null = null;
  tooltipValue: string = '';
  
  cellsWithOverflow: Set<string> = new Set();

  screenWidth: number;

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private cookieService: CookieService,
    private swUpdate: SwUpdate
  ) {
    // set screenWidth on page load
    this.screenWidth = window.innerWidth;
    window.onresize = () => {
      // set screenWidth on screen size change
      this.screenWidth = window.innerWidth;
    };
    
    this.route.queryParams.subscribe(queryParams => {
      queryParams['income'] && this.income.setValue(Number(queryParams['income']));
      queryParams['startFrom'] && this.startFrom.setValue(queryParams['startFrom']);
      queryParams['selectedYear'] && this.selectedYear.setValue(queryParams['selectedYear']);
      queryParams['older'] && this.older.setValue(queryParams['older'] === 'true');
      queryParams['allowance'] && this.allowance.setValue(queryParams['allowance'] === 'true');
      queryParams['hoursAmount'] && this.hoursAmount.setValue(queryParams['hoursAmount']);
      queryParams['ruling'] && this.ruling.setValue(queryParams['ruling'] === 'true');
      queryParams['holidayPayoutMay'] && this.holidayPayoutMay.setValue(queryParams['holidayPayoutMay'] === 'true');
      queryParams['partialYear'] && this.partialYear.setValue(queryParams['partialYear'] === 'true');
      queryParams['workedDuration'] && this.workedDuration.setValue(Number(queryParams['workedDuration']));
      queryParams['workedPeriod'] && this.workedPeriod.setValue(queryParams['workedPeriod']);
    });

    // The valid range for "worked" depends on the period (max 52 weeks / 12 months),
    // so re-run its validators whenever the period switches.
    this.workedPeriod.valueChanges.subscribe(() => {
      this.workedDuration.updateValueAndValidity({ emitEvent: false });
    });

    merge(
      this.income.valueChanges,
      this.startFrom.valueChanges,
      this.selectedYear.valueChanges,
      this.older.valueChanges,
      this.allowance.valueChanges,
      this.holidayPayoutMay.valueChanges,
      this.hoursAmount.valueChanges,
      this.rulingChoice.valueChanges,
      this.ruling.valueChanges,
      this.partialYear.valueChanges,
      this.workedDuration.valueChanges,
      this.workedPeriod.valueChanges
    ).subscribe((_) => {
      this.updateRouter();
      this.recalculate();
    });
  }

  ngOnInit(): void {
    this.recalculate();

    // Load total calculations from cookie
    const savedCalculations = this.cookieService.get('totalCalculations');
    this.totalCalculations = savedCalculations ? parseInt(savedCalculations, 10) : 0;

    // Setup calculation tracking
    this.calculationSubject.pipe(
      debounceTime(this.CALCULATION_DEBOUNCE_TIME),  // Wait for user to stop making changes
    ).subscribe(() => {
      this.meaningfulCalculations++;
      if (this.meaningfulCalculations >= this.CALCULATIONS_BEFORE_DONATE) {
        this.showDonateButton = true;
        // Increment and save total calculations
        this.totalCalculations++;
        this.cookieService.set('totalCalculations', this.totalCalculations.toString(), 365); // store for 1 year
      }
    });

    if (this.swUpdate.isEnabled) {
      // Activate new version as soon as it's ready, then reload
      this.swUpdate.versionUpdates.pipe(
        filter(evt => evt.type === 'VERSION_READY'),
        takeUntil(this.destroy$)
      ).subscribe(() => {
        this.swUpdate.activateUpdate().then(() => document.location.reload());
      });

      // Check on tab becoming visible (catches returning users with stale SW)
      fromEvent(document, 'visibilitychange').pipe(
        filter(() => document.visibilityState === 'visible'),
        takeUntil(this.destroy$)
      ).subscribe(() => this.swUpdate.checkForUpdate());

      // Periodic check every 6 hours for long-running tabs
      interval(6 * 60 * 60 * 1000).pipe(
        takeUntil(this.destroy$)
      ).subscribe(() => this.swUpdate.checkForUpdate());
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }


  ngAfterViewChecked(): void {
    const isMobile = this.screenWidth <= 600;
    const hasData = this.dataSource && this.dataSource.length > 0;
    
    if (!isMobile || !hasData) {
      return;
    }

    requestAnimationFrame(() => {
      this.dataSource.forEach(element => {
        const cellSelector = `td.report-value[data-cell-id="${element.name}"]`;
        const cell = document.querySelector(cellSelector) as HTMLElement;
        
        if (cell) {
          const hasOverflow = cell.scrollWidth > cell.clientWidth;
          if (hasOverflow) {
            this.cellsWithOverflow.add(element.name);
          } else {
            this.cellsWithOverflow.delete(element.name);
          }
        }
      });
    });
  }

  recalculate(): void {
    this.calculationSubject.next();

    const startFrom = this.startFrom.getRawValue()!;
    const year = +(this.selectedYear.getRawValue() ?? constants.currentYear);
    const ruling = {
      checked: this.ruling.getRawValue() ?? false,
      choice: this.rulingChoice.getRawValue() ?? 'normal',
    } as any;
    const salary = {
      income: this.income.getRawValue() ?? 0,
      allowance: this.allowance.getRawValue() ?? false,
      socialSecurity: true,
      older: this.older.getRawValue() ?? false,
      hours: this.hoursAmount.getRawValue() ?? 0,
    };

    // Partial year: only employed part of the year, so pro-rate the income and the
    // (annual) 30% ruling norm and cap. Skipped while the duration is invalid.
    const partial = this.partialYear.getRawValue() ?? false;
    const workedPeriod = this.workedPeriod.getRawValue() ?? 'Weeks';
    const periodTotal = workedPeriod === 'Months' ? 12 : this.workingWeeks;
    const workedDuration = Number(this.workedDuration.getRawValue());
    const isPartial = partial && this.workedDuration.valid && workedDuration < periodTotal;
    const fraction = isPartial ? workedDuration / periodTotal : 1;

    if (isPartial) {
      // Keep only the worked fraction of the annualised gross (the package rounds it).
      const fullYear: any = new SalaryPaycheck(salary, startFrom, year, ruling);
      const proRated = { ...salary, income: fullYear.inputGrossYear * fraction };
      this.paycheck = this.proRatedPaycheck(proRated, year, ruling, fraction);

      // Yearly fields hold the period total; rescale per-period values to the worked cadence.
      const scale = 1 / fraction;
      PERIOD_FIELDS.forEach((key) => (this.paycheck[key] *= scale));
    } else {
      this.paycheck = new SalaryPaycheck(salary, startFrom, year, ruling);
    }

    // fraction is 1 for a full year, so these reduce to the standard counts.
    const monthsWorked = 12 * fraction;
    const weeksCount = this.workingWeeks * fraction;
    const daysCount = constants.workingDays * fraction;

    const mayPayout = this.holidayPayoutMay.getRawValue() && this.allowance.getRawValue();
    const netAllowance = this.paycheck.netAllowance || 0;

    this.dataSource = this.extraOptions
      .filter((option) => option.checked)
      .map((option) => {
        let value = this.paycheck[option.name];

        // When May payout is selected, exclude holiday from period amounts
        if (mayPayout && netAllowance > 0) {
          const netYearWithoutHoliday = this.paycheck.netYear - netAllowance;
          switch (option.name) {
            case 'netMonth':
              value = netYearWithoutHoliday / monthsWorked;
              break;
            case 'netWeek':
              value = netYearWithoutHoliday / weeksCount;
              break;
            case 'netDay':
              value = netYearWithoutHoliday / daysCount;
              break;
            case 'netHour':
              value = netYearWithoutHoliday / (weeksCount * (this.hoursAmount.getRawValue() || 40));
              break;
          }
        }

        return { name: option.title, value };
      });


    this.cellsWithOverflow.clear();
  }

  /**
   * Build a paycheck with the 30% ruling salary norm and cap pro-rated to the worked
   * period. The package reads both from the shared `constants` singleton and offers no
   * override, so they are temporarily scaled and restored around the calculation.
   */
  private proRatedPaycheck(salary: any, year: number, ruling: any, fraction: number): any {
    const C = constants as any;
    const threshold = C.rulingThreshold[year][ruling.choice];
    const cap = C.rulingMaxSalary[year];
    try {
      C.rulingThreshold[year][ruling.choice] = threshold * fraction;
      C.rulingMaxSalary[year] = cap * fraction;
      return new SalaryPaycheck(salary, 'Year', year, ruling);
    } finally {
      C.rulingThreshold[year][ruling.choice] = threshold;
      C.rulingMaxSalary[year] = cap;
    }
  }


  showTooltip(cellId: string, element: { name: string; value: number }, event: MouseEvent): void {
    const isMobile = this.screenWidth <= 600;
    if (!isMobile) {
      return;
    }

    const cell = event.currentTarget as HTMLElement;
    const hasOverflow = cell.scrollWidth > cell.clientWidth;
    
    if (!hasOverflow) {
      return;
    }

    // Toggle: if tooltip is already showing for this cell, hide it
    if (this.tooltipCell === cellId) {
      this.hideTooltip();
      return;
    }

    // Show tooltip with formatted value
    this.tooltipCell = cellId;
    this.tooltipValue = this.formatValueForTooltip(element);
    
    // Position tooltip above the cell, centered
    const cellRect = cell.getBoundingClientRect();
    this.tooltipPosition = {
      x: cellRect.left + cellRect.width / 2,
      y: cellRect.top - 10
    };
  }

  private formatValueForTooltip(element: { name: string; value: number }): string {
    if (element.name === 'Ruling Real Percentage') {
      return `${element.value} %`;
    }
    
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2
    }).format(element.value);
  }


  hideTooltip(): void {
    this.tooltipCell = null;
    this.tooltipPosition = null;
    this.tooltipValue = '';
  }

  updateRouter() {
    const raw: Record<string, unknown> = {
      income: this.income.getRawValue(),
      startFrom: this.startFrom.getRawValue(),
      selectedYear: this.selectedYear.getRawValue(),
      older: this.older.getRawValue(),
      allowance: this.allowance.getRawValue(),
      socialSecurity: true,
      hoursAmount: this.hoursAmount.getRawValue(),
      ruling: this.ruling.getRawValue(),
      holidayPayoutMay: this.holidayPayoutMay.getRawValue(),
      partialYear: this.partialYear.getRawValue(),
      workedDuration: this.workedDuration.getRawValue(),
      workedPeriod: this.workedPeriod.getRawValue(),
    };

    // Map invalid values to null so Angular Router removes them from the URL.
    // Filtering them out entirely would leave stale values in the URL when
    // using queryParamsHandling: 'merge'.
    const params = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [
        k,
        v === null || v === undefined || v === '' || Number.isNaN(v) ? null : v,
      ])
    );

    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: params,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
